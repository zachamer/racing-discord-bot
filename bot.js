const { Client, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');
const moment = require('moment-timezone');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Initialize BetsAPI
const BETSAPI_TOKEN = process.env.BETSAPI_TOKEN;
const ODDS_CHANNEL_ID = '1401917437921722398'; // Channel for odds drop alerts

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store upcoming races for notifications
let upcomingRaces = [];
let notificationsSent = new Set(); // Track which races we've already notified about

// Store odds tracking data
let trackedRaces = new Map(); // Map of race IDs to race data
let oddsHistory = new Map(); // Map of race IDs to odds history
let oddsAlertsChannelSent = new Set(); // Track odds alerts sent

// Japanese horse racing tracks to monitor
const JAPANESE_TRACKS = [
    'Mizusawa', 'Kanazawa', 'Kawasaki', 'Tokyo Keiba', 
    'Sonoda', 'Nagoya', 'Kochi', 'Saga'
];

// Advanced function to analyze racing screenshot with AI
async function analyzeRacingImageWithAI(imageUrl) {
    try {
        console.log('🤖 Analyzing image with AI:', imageUrl);
        
        // Check if OpenAI API key is available
        if (!openai.apiKey || openai.apiKey === 'demo-key') {
            return await fallbackAnalysis(imageUrl);
        }
        
        // Use OpenAI Vision API for better analysis
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analyze this racing screenshot and extract:
1. Race times (look for times like 3:30 PM, 15:30, etc.) - CONVERT ALL TIMES TO MELBOURNE TIMEZONE
2. SPECIFIC race names or track information (e.g. "Maiden Handicap", "Group 1 Stakes", "Listed Stakes", "Class 2 Handicap", track names like "Flemington", "Randwick", etc.)
3. Horse names and odds
4. Any countdown timers or "time to race" information - CALCULATE FROM MELBOURNE CURRENT TIME
5. Current time shown in the image - NOTE THE TIMEZONE
6. Look for race class/grade information (Class 1, Class 2, Group races, etc.)
7. Look for race conditions (Maiden, Handicap, Allowance, etc.)

IMPORTANT: Always calculate race times and countdowns relative to Melbourne timezone (AEDT/AEST).
If the screenshot shows a different timezone, convert everything to Melbourne time.
Focus on identifying when races are scheduled and calculate time remaining from current Melbourne time.
Look closely for specific race titles, conditions, or track names that identify each race uniquely.
If you see bet365 or other betting site interfaces, extract all visible race information including specific race names.
Return the information in a structured format with as much detail as possible about each race's name/type.`
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: imageUrl
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000
        });

        const analysis = response.choices[0].message.content;
        console.log('🔍 AI Analysis:', analysis);
        
        // Parse race information using AI
        const raceInfo = await parseRaceInformation(analysis);
        
        // Add races to notification system if any found
        if (raceInfo && raceInfo.races && raceInfo.races.length > 0) {
            addRacesToNotifications(raceInfo);
        }

        return {
            isRacing: true,
            analysis: analysis,
            raceInfo: raceInfo,
            enhanced: true
        };

    } catch (error) {
        console.error('❌ AI analysis failed:', error);
        return await fallbackAnalysis(imageUrl);
    }
}

// Function to parse race information and normalize using AI
async function parseRaceInformation(aiAnalysis) {
    try {
        console.log('🧠 Using AI to normalize race information...');
        
        // Use AI to parse the AI analysis into our standardized format
        const normalizeResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a race data parser. Convert racing analysis into a standardized JSON format. 
                    
                    Return ONLY valid JSON with this exact structure:
                    {
                        "races": [
                            {
                                "race": "R1",
                                "time": "14:30",
                                "countdownMinutes": 25,
                                "raceName": "Specific race name here"
                            }
                        ]
                    }
                    
                    Rules:
                    - race: Use format like "R1", "R2", etc. or track name
                    - time: 24-hour format HH:MM (will be interpreted as Melbourne time)
                    - countdownMinutes: numeric minutes until race starts FROM CURRENT MELBOURNE TIME
                    - raceName: Extract the ACTUAL race name from the screenshot (e.g. "Maiden Handicap", "Group 1 Cox Plate", "Class 2 Sprint", "Allowance Race", track names like "Flemington R1", etc.). Do NOT use generic names like "Race 1" unless no specific name is visible.
                    - Look for race conditions like Maiden, Handicap, Group races, Class numbers, Stakes races
                    - If no specific race name is visible, use distance + race type (e.g. "1400m Maiden", "900m Sprint")
                    - Calculate countdownMinutes based on Melbourne timezone (AEDT/AEST)
                    - Only include races that are upcoming (not completed)
                    - If no valid races found, return {"races": []}`
                },
                {
                    role: "user",
                    content: `Parse this racing analysis into the standardized format:\n\n${aiAnalysis}`
                }
            ],
            max_tokens: 1000,
            temperature: 0.1
        });

        let normalizedData = normalizeResponse.choices[0].message.content.trim();
        
        // Clean up markdown code fences if present
        if (normalizedData.startsWith('```json')) {
            normalizedData = normalizedData.replace(/```json\s*/, '').replace(/\s*```$/, '');
        } else if (normalizedData.startsWith('```')) {
            normalizedData = normalizedData.replace(/```\s*/, '').replace(/\s*```$/, '');
        }
        
        const parsed = JSON.parse(normalizedData);
        console.log('✅ AI parsing successful:', parsed);
        return parsed;
        
    } catch (error) {
        console.error('❌ AI parsing failed:', error);
        // Fallback to simple parsing
        return { races: [] };
    }
}

// Function to add races to the notification system
function addRacesToNotifications(raceInfo) {
    const currentTime = moment().tz('Australia/Melbourne');
    
    // Handle both old (raceTimes) and new (races) format for compatibility
    const races = raceInfo.races || raceInfo.raceTimes || [];
    
    races.forEach(race => {
        // Always start with current Melbourne time for calculations
        const raceTime = moment().tz('Australia/Melbourne');
        
        // Parse the race time based on available data
        if (race.countdownSeconds) {
            raceTime.add(race.countdownSeconds, 'seconds');
        } else if (race.countdownMinutes) {
            raceTime.add(race.countdownMinutes, 'minutes');
        } else if (race.timeUntilRace > 0) {
            raceTime.add(race.timeUntilRace, 'minutes');
        } else if (race.time) {
            // If we have a specific time (e.g., "14:30"), set it for today in Melbourne timezone
            const [hours, minutes] = race.time.split(':').map(Number);
            raceTime.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
            
            // If the race time has already passed today, assume it's tomorrow
            if (raceTime.isBefore(currentTime)) {
                raceTime.add(1, 'day');
            }
        } else {
            console.log(`⚠️ Skipping race ${race.race} - no valid time information`);
            return; // Skip races that have no time information
        }
        
        console.log(`🕐 Race ${race.race} calculated time: ${raceTime.format('YYYY-MM-DD HH:mm:ss [Melbourne Time]')}`);
        
        // Only add races that are within the next 24 hours
        if (raceTime.diff(currentTime, 'hours') <= 24 && raceTime.isAfter(currentTime)) {
            const raceKey = `${race.race}-${raceTime.toISOString()}`;
            
            // Enhanced duplicate detection - check multiple criteria
            const existingRace = upcomingRaces.find(r => {
                const timeDiff = Math.abs(moment(r.raceTime).diff(raceTime, 'minutes'));
                return (
                    // Same race identifier and very close time (within 2 minutes)
                    (r.race === race.race && timeDiff < 2) ||
                    // Same exact race key
                    `${r.race}-${r.raceTime}` === raceKey ||
                    // Same race name and close time (for races with proper names)
                    (r.raceName && race.raceName && 
                     r.raceName === race.raceName && 
                     r.raceName !== 'Unknown Race' && 
                     timeDiff < 5)
                );
            });
            
            if (!existingRace) {
                upcomingRaces.push({
                    race: race.race,
                    raceTime: raceTime.toISOString(),
                    raceName: race.raceName || race.original || race.time || 'Unknown Race',
                    addedAt: currentTime.toISOString()
                });
                
                console.log(`📅 Added ${race.race} to notifications: ${raceTime.format('HH:mm:ss')} Melbourne Time`);
            } else {
                console.log(`🔄 Skipped duplicate race: ${race.race} at ${raceTime.format('HH:mm:ss')}`);
            }
        }
    });
    
    // Clean up any potential duplicates that might have slipped through
    const uniqueRaces = [];
    upcomingRaces.forEach(race => {
        const isDuplicate = uniqueRaces.some(existing => {
            const timeDiff = Math.abs(moment(existing.raceTime).diff(moment(race.raceTime), 'minutes'));
            return (
                (existing.race === race.race && timeDiff < 2) ||
                (existing.raceName && race.raceName && 
                 existing.raceName === race.raceName && 
                 existing.raceName !== 'Unknown Race' && 
                 timeDiff < 5)
            );
        });
        
        if (!isDuplicate) {
            uniqueRaces.push(race);
        } else {
            console.log(`🗑️ Removed duplicate during cleanup: ${race.race}`);
        }
    });
    
    upcomingRaces = uniqueRaces;
    
    console.log(`📊 Total races being monitored: ${upcomingRaces.length}`);
}

// Fallback analysis if AI fails
async function fallbackAnalysis(imageUrl) {
    console.log('🔄 Using fallback analysis');
    
    return {
        isRacing: true,
        analysis: 'Racing content detected! AI analysis unavailable - add your OpenAI API key for advanced features.',
        raceInfo: {
            races: [],
            currentMelbourneTime: moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')
        }
    };
}

// ==================== BETSAPI ODDS TRACKING SYSTEM ====================

// Function to get upcoming horse racing events from BetsAPI
async function getUpcomingHorseRaces() {
    if (!BETSAPI_TOKEN) {
        console.log('⚠️ BetsAPI token not configured - skipping odds tracking');
        return [];
    }

    try {
        console.log('🔍 Fetching upcoming horse races from BetsAPI...');
        
        // Horse Racing is typically sport_id 2 in BetsAPI
        const response = await axios.get('https://api.b365api.com/v1/bet365/upcoming', {
            params: {
                sport_id: 2, // Horse Racing
                token: BETSAPI_TOKEN
            },
            timeout: 10000
        });

        if (response.data && response.data.results) {
            const allRaces = response.data.results;
            
            // Filter for Japanese tracks
            const japaneseRaces = allRaces.filter(race => {
                const raceName = race.league?.name || race.home?.name || '';
                return JAPANESE_TRACKS.some(track => 
                    raceName.toLowerCase().includes(track.toLowerCase())
                );
            });

            console.log(`🏇 Found ${japaneseRaces.length} Japanese horse races`);
            return japaneseRaces;
        }

        return [];
    } catch (error) {
        console.error('❌ Error fetching horse races from BetsAPI:', error.message);
        return [];
    }
}

// Function to get detailed odds for a specific race
async function getRaceOdds(raceId) {
    if (!BETSAPI_TOKEN) return null;

    try {
        const response = await axios.get('https://api.b365api.com/v1/bet365/event', {
            params: {
                FI: raceId,
                token: BETSAPI_TOKEN
            },
            timeout: 10000
        });

        if (response.data && response.data.results) {
            return response.data.results;
        }

        return null;
    } catch (error) {
        console.error(`❌ Error fetching odds for race ${raceId}:`, error.message);
        return null;
    }
}

// Function to detect significant odds drops
function detectOddsDrops(raceId, currentOdds, previousOdds) {
    const drops = [];
    
    if (!previousOdds || !currentOdds) return drops;

    // Compare each horse's odds
    Object.keys(currentOdds).forEach(horseName => {
        const currentOdd = parseFloat(currentOdds[horseName]);
        const previousOdd = parseFloat(previousOdds[horseName]);

        if (previousOdd && currentOdd && previousOdd > currentOdd) {
            const dropPercentage = ((previousOdd - currentOdd) / previousOdd) * 100;
            
            if (dropPercentage >= 20) {
                drops.push({
                    horseName: horseName,
                    previousOdds: previousOdd,
                    currentOdds: currentOdd,
                    dropPercentage: Math.round(dropPercentage * 10) / 10,
                    raceId: raceId
                });
            }
        }
    });

    return drops;
}

// Function to process and store race odds
async function updateRaceOdds(race) {
    const raceId = race.id;
    const currentTime = moment().tz('Australia/Melbourne');
    const raceTime = moment.unix(race.time);
    const minutesUntilRace = raceTime.diff(currentTime, 'minutes');

    // Only track races that are 1-5 minutes away
    if (minutesUntilRace < 1 || minutesUntilRace > 5) {
        return;
    }

    console.log(`📊 Updating odds for race ${raceId} (${minutesUntilRace}m until start)`);

    const oddsData = await getRaceOdds(raceId);
    if (!oddsData) return;

    // Extract horse odds from the API response
    const currentOdds = {};
    if (oddsData.odds && Array.isArray(oddsData.odds)) {
        oddsData.odds.forEach(market => {
            if (market.type === 'win' || market.type === 'place') {
                market.values?.forEach(horse => {
                    if (horse.odds) {
                        currentOdds[horse.name] = horse.odds;
                    }
                });
            }
        });
    }

    // Get previous odds for comparison
    const raceHistory = oddsHistory.get(raceId) || [];
    const previousOdds = raceHistory.length > 0 ? raceHistory[raceHistory.length - 1].odds : null;

    // Detect odds drops
    if (previousOdds && minutesUntilRace <= 3) {
        const drops = detectOddsDrops(raceId, currentOdds, previousOdds);
        
        if (drops.length > 0) {
            await sendOddsDropAlert(race, drops);
        }
    }

    // Store current odds in history
    raceHistory.push({
        timestamp: currentTime.toISOString(),
        odds: currentOdds,
        minutesUntilRace: minutesUntilRace
    });

    // Keep only last 10 entries
    if (raceHistory.length > 10) {
        raceHistory.shift();
    }

    oddsHistory.set(raceId, raceHistory);
}

// Function to send odds drop alerts
async function sendOddsDropAlert(race, drops) {
    try {
        const channel = await client.channels.fetch(ODDS_CHANNEL_ID);
        if (!channel) {
            console.log('❌ Odds alert channel not found');
            return;
        }

        const raceTime = moment.unix(race.time);
        const minutesUntil = raceTime.diff(moment().tz('Australia/Melbourne'), 'minutes');
        const raceName = race.league?.name || race.home?.name || 'Unknown Race';

        let alertMessage = `🚨 **ODDS DROP ALERT!** 🚨\n\n`;
        alertMessage += `🏇 **Race**: ${raceName}\n`;
        alertMessage += `⏰ **Time**: ${raceTime.format('HH:mm')} (${minutesUntil}m away)\n\n`;
        alertMessage += `📉 **Significant Odds Drops (20%+):**\n`;

        drops.forEach(drop => {
            alertMessage += `• **${drop.horseName}**: ${drop.previousOdds} → ${drop.currentOdds} (${drop.dropPercentage}% drop)\n`;
        });

        alertMessage += `\n🎯 These horses have significant market movement!`;

        // Create unique key to prevent duplicate alerts
        const alertKey = `${race.id}-${drops.map(d => d.horseName).join('-')}`;
        
        if (!oddsAlertsChannelSent.has(alertKey)) {
            await channel.send(alertMessage);
            oddsAlertsChannelSent.add(alertKey);
            console.log(`🔔 Sent odds drop alert for ${drops.length} horses in race ${race.id}`);
        }

    } catch (error) {
        console.error('❌ Error sending odds drop alert:', error);
    }
}

// Function to monitor all tracked races for odds changes
async function monitorOddsChanges() {
    if (!BETSAPI_TOKEN) return;

    console.log('📊 Monitoring odds changes...');
    
    try {
        const upcomingRaces = await getUpcomingHorseRaces();
        
        // Process each race
        for (const race of upcomingRaces) {
            const raceTime = moment.unix(race.time);
            const minutesUntil = raceTime.diff(moment().tz('Australia/Melbourne'), 'minutes');
            
            // Only monitor races 1-5 minutes away
            if (minutesUntil >= 1 && minutesUntil <= 5) {
                await updateRaceOdds(race);
                
                // Small delay between API calls to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Clean up old odds history (races more than 1 hour old)
        const oneHourAgo = moment().subtract(1, 'hour');
        for (const [raceId, history] of oddsHistory.entries()) {
            const lastUpdate = moment(history[history.length - 1]?.timestamp);
            if (lastUpdate.isBefore(oneHourAgo)) {
                oddsHistory.delete(raceId);
                console.log(`🗑️ Cleaned up old odds data for race ${raceId}`);
            }
        }

        // Clean up old alert tracking
        if (oddsAlertsChannelSent.size > 1000) {
            oddsAlertsChannelSent.clear();
            console.log('🗑️ Cleared old odds alerts tracking');
        }

    } catch (error) {
        console.error('❌ Error monitoring odds changes:', error);
    }
}

// Function to check for upcoming races and send notifications
async function checkUpcomingRaces() {
    const currentTime = moment().tz('Australia/Melbourne');
    const notificationChannel = process.env.NOTIFICATION_CHANNEL_ID;
    
    if (!notificationChannel) {
        console.log('⚠️ No notification channel configured');
        return;
    }
    
    try {
        const channel = await client.channels.fetch(notificationChannel);
        if (!channel) {
            console.log('❌ Notification channel not found');
            return;
        }
        
        // Check each race
        for (let i = upcomingRaces.length - 1; i >= 0; i--) {
            const race = upcomingRaces[i];
            const raceTime = moment(race.raceTime);
            const minutesUntilRace = raceTime.diff(currentTime, 'minutes');
            const notificationKey = `${race.race}-${raceTime.toISOString()}`;
            
            // Remove races that have already started (give 10 minutes buffer)
            if (minutesUntilRace < -10) {
                console.log(`🗑️ Removing expired race: ${race.race}`);
                upcomingRaces.splice(i, 1);
                notificationsSent.delete(notificationKey);
                continue;
            }
            
            // Send notification 5 minutes before race
            if (minutesUntilRace <= 5 && minutesUntilRace > 0 && !notificationsSent.has(notificationKey)) {
                // Include race name if available
                const raceDisplay = race.raceName && race.raceName !== 'Unknown Race' && race.raceName !== race.race 
                    ? `**${race.race}** (${race.raceName})` 
                    : `**${race.race}**`;
                
                const message = `🔔 @everyone **RACE ALERT!**\n\n🏇 ${raceDisplay} starts in **${minutesUntilRace} minutes**!\n⏰ Race time: ${raceTime.format('HH:mm')} Melbourne time\n\n🎯 Get ready to place your bets!`;
                
                await channel.send(message);
                notificationsSent.add(notificationKey);
                console.log(`🔔 Sent notification for ${race.race} (${minutesUntilRace} minutes remaining)`);
            }
        }
        
    } catch (error) {
        console.error('❌ Error checking upcoming races:', error);
    }
}

// Bot ready event
client.once('ready', () => {
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`🕐 Current Melbourne time: ${moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}`);
    console.log(`🔔 Notification system active - monitoring channel: ${process.env.NOTIFICATION_CHANNEL_ID}`);
    console.log(`📊 Odds tracking active - monitoring channel: ${ODDS_CHANNEL_ID}`);
    
    // Set up race notification checker (every 30 seconds)
    setInterval(checkUpcomingRaces, 30000);
    console.log(`⏰ Race notification checker started (every 30 seconds)`);
    
    // Set up odds monitoring (every 30 seconds)
    if (BETSAPI_TOKEN) {
        setInterval(monitorOddsChanges, 30000);
        console.log(`📈 Odds monitoring started (every 30 seconds) for Japanese tracks`);
        console.log(`🏇 Tracking: ${JAPANESE_TRACKS.join(', ')}`);
    } else {
        console.log(`⚠️ BetsAPI token not configured - odds tracking disabled`);
    }
});

// Listen for messages with images
client.on('messageCreate', async (message) => {
    console.log(`📩 Message received: "${message.content}" from ${message.author.username}`);
    
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Simple help command
    if (message.content.toLowerCase() === '!help') {
        console.log('🆘 Help command detected');
        const melbourneTime = moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]');
        const hasOpenAI = openai.apiKey && openai.apiKey !== 'demo-key';
        
        await message.reply({
            content: `🤖 **Enhanced Racing Bot with AI Analysis & Notifications**\n\n📸 **Upload racing screenshots** and I'll analyze them!\n🏇 **I can detect:**\n• Race times and countdowns\n• Horse names and odds\n• Time until races start\n• Convert times to Melbourne timezone\n\n🔔 **Notification System:**\n• Automatically monitors race times\n• Sends @everyone alerts 5 minutes before races\n• Works across channels for maximum coverage\n\n� **Odds Tracking System:**\n• Monitors Japanese horse racing tracks\n• Detects 20%+ odds drops from 3min to 20sec before races\n• Tracks: Mizusawa, Kanazawa, Kawasaki, Tokyo Keiba, Sonoda, Nagoya, Kochi, Saga\n• Alerts sent to <#${ODDS_CHANNEL_ID}>\n\n�🕐 **Current Melbourne Time:** ${melbourneTime}\n\n🤖 **AI Status:** ${hasOpenAI ? '✅ OpenAI Enabled' : '❌ Add OpenAI API key for advanced analysis'}\n📊 **BetsAPI Status:** ${BETSAPI_TOKEN ? '✅ Enabled' : '❌ Add BETSAPI_TOKEN for odds tracking'}\n\n**Commands:**\n• \`!clear\` - Remove all race notifications\n• \`!status\` - Show active notifications\n• \`!odds\` - Show odds tracking status\n\n*Just upload an image and I'll analyze it AND set up notifications!*`
        });
        return;
    }
    
    // Handle !clear command to delete all notifications
    if (message.content.toLowerCase() === '!clear') {
        const clearedCount = upcomingRaces.length;
        upcomingRaces.length = 0; // Clear the array
        notificationsSent.clear(); // Clear sent notifications set
        
        await message.reply(`🗑️ **Cleared ${clearedCount} race notifications!**\n\n✅ All upcoming race alerts have been removed.\n🔄 Upload a new racing screenshot to set up fresh notifications.`);
        console.log(`🗑️ Cleared ${clearedCount} notifications via !clear command`);
        return;
    }
    
    // Handle !status command to show current notifications
    if (message.content.toLowerCase() === '!status') {
        if (upcomingRaces.length === 0) {
            await message.reply(`📊 **No active race notifications**\n\n📸 Upload a racing screenshot to set up notifications!`);
        } else {
            let statusText = `📊 **Active Race Notifications (${upcomingRaces.length}):**\n\n`;
            
            // Sort races by time (soonest first)
            const sortedRaces = [...upcomingRaces].sort((a, b) => {
                return moment(a.raceTime).diff(moment(b.raceTime));
            });
            
            sortedRaces.forEach((race, index) => {
                const raceTime = moment(race.raceTime);
                const minutesUntil = raceTime.diff(moment().tz('Australia/Melbourne'), 'minutes');
                const alertTime = moment(race.raceTime).subtract(5, 'minutes');
                
                // Include race name if available and different from race identifier
                const raceDisplay = race.raceName && race.raceName !== 'Unknown Race' && race.raceName !== race.race 
                    ? `**${race.race}** (${race.raceName})` 
                    : `**${race.race}**`;
                
                statusText += `🏇 ${raceDisplay} - ${raceTime.format('HH:mm')}\n`;
                statusText += `   ⏰ Alert in ${Math.max(0, minutesUntil - 5)} minutes (${alertTime.format('HH:mm')})\n\n`;
            });
            
            statusText += `🔄 Use \`!clear\` to remove all notifications`;
            await message.reply(statusText);
        }
        return;
    }
    
    // Handle !odds command to show odds tracking status
    if (message.content.toLowerCase() === '!odds') {
        let oddsText = `📈 **Odds Tracking Status**\n\n`;
        
        if (!BETSAPI_TOKEN) {
            oddsText += `❌ **BetsAPI not configured**\nAdd BETSAPI_TOKEN to .env file to enable odds tracking`;
        } else {
            oddsText += `✅ **BetsAPI Active**\n`;
            oddsText += `🏇 **Monitoring Tracks**: ${JAPANESE_TRACKS.join(', ')}\n`;
            oddsText += `📊 **Alert Channel**: <#${ODDS_CHANNEL_ID}>\n`;
            oddsText += `⚡ **Detection**: 20%+ odds drops from 3min to 20sec before race\n\n`;
            
            const trackedCount = oddsHistory.size;
            oddsText += `📊 **Currently Tracking**: ${trackedCount} races\n`;
            
            if (trackedCount > 0) {
                oddsText += `\n**Active Races:**\n`;
                let count = 0;
                for (const [raceId, history] of oddsHistory.entries()) {
                    if (count >= 5) break; // Show max 5 races
                    const lastEntry = history[history.length - 1];
                    const horseCount = Object.keys(lastEntry.odds).length;
                    oddsText += `• Race ${raceId}: ${horseCount} horses (${lastEntry.minutesUntilRace}m away)\n`;
                    count++;
                }
                if (trackedCount > 5) {
                    oddsText += `• ... and ${trackedCount - 5} more races\n`;
                }
            }
        }
        
        await message.reply(oddsText);
        return;
    }
    
    // Check if message has attachments and is from the correct channel
    if (message.attachments.size === 0) return;
    
    // Only analyze images from the specific racing screenshots channel
    if (message.channel.id !== '1401539500345131048') {
        console.log(`📸 Image detected but ignoring - wrong channel: ${message.channel.id}`);
        return;
    }
    
    console.log('📸 Image detected in racing channel, analyzing with AI...');
    
    // Process each attachment
    for (const attachment of message.attachments.values()) {
        // Check if attachment is an image
        if (!attachment.contentType?.startsWith('image/')) continue;
        
        try {
            const result = await analyzeRacingImageWithAI(attachment.url);
            
            console.log('📝 Analysis result:', result);
            
            if (result.isRacing) {
                // Create detailed response
                let responseText = `🏇 **Racing Screenshot Analyzed!**\n\n`;
                responseText += `🤖 **Analysis:**\n\`\`\`\n${result.analysis.substring(0, 400)}...\n\`\`\`\n\n`;
                
                if (result.raceInfo && (result.raceInfo.races || result.raceInfo.raceTimes)) {
                    // Add races to notification system
                    addRacesToNotifications(result.raceInfo);
                    
                    responseText += `⏰ **Race Times (Melbourne):**\n`;
                    const races = result.raceInfo.races || result.raceInfo.raceTimes || [];
                    races.forEach(race => {
                        const timeLeft = race.timeUntilRace || race.countdownMinutes || 0;
                        const timeDisplay = timeLeft > 0 ? `${timeLeft} minutes` : 'Started';
                        const raceLabel = race.race ? `${race.race}: ` : '';
                        
                        let countdownInfo = '';
                        if (race.countdownSeconds) {
                            countdownInfo = ` (${race.countdownSeconds}s countdown)`;
                        } else if (race.countdownMinutes) {
                            countdownInfo = ` (${race.countdownMinutes}m countdown)`;
                        }
                        
                        const raceTime = race.time || 'Unknown time';
                        const melbourneTime = race.melbourneTime || 'Melbourne time';
                        responseText += `• ${raceLabel}${raceTime} → ${melbourneTime} (${timeDisplay})${countdownInfo}\n`;
                    });
                    
                    responseText += `\n🔔 **Notifications set up!** I'll alert @ everyone 5 minutes before each race in <#${process.env.NOTIFICATION_CHANNEL_ID}>`;
                } else {
                    responseText += `⚠️ No upcoming races detected in this image.`;
                }
                
                responseText += `\n\n⏰ **Current Melbourne Time:** ${moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}`;
                
                await message.reply(responseText);
            } else {
                await message.reply('❌ This doesn\'t appear to be a racing-related image. Please upload a screenshot from bet365 or another racing website.');
            }
            
        } catch (error) {
            console.error('❌ Error processing image:', error);
            await message.reply('❌ Sorry, I encountered an error processing that image. Please try again with a clear racing screenshot.');
        }
    }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
