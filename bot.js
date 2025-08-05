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
const RACE_ALERTS_CHANNEL_ID = '1401527867447443456'; // Channel for 5-minute race alerts

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
let twoMinuteOdds = new Map(); // Store odds captured at 2 minutes before race

// Japanese horse racing tracks to monitor
const JAPANESE_TRACKS = [
    'Mizusawa', 'Kanazawa', 'Kawasaki', 'Tokyo Keiba', 
    'Sonoda', 'Nagoya', 'Kochi', 'Saga', 'Morioka'
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
1. Race times (look for times like 3:30 PM, 15:30, etc.)
2. Race names or track information
3. Horse names and odds
4. Any countdown timers or "time to race" information
5. Current time shown in the image

Focus on identifying when races are scheduled and calculate time remaining. 
If you see bet365 or other betting site interfaces, extract all visible race information.
Return the information in a structured format.`
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
            max_tokens: 500
        });

        const analysis = response.choices[0].message.content;
        console.log('🤖 AI Analysis:', analysis);

        // Extract race times and calculate Melbourne time
        const raceInfo = parseRaceInformation(analysis);
        
        return {
            isRacing: true,
            analysis: analysis,
            raceInfo: raceInfo,
            melbourneTime: moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')
        };

    } catch (error) {
        console.error('❌ AI Analysis error:', error.message);
        
        // Fallback to simple analysis
        return await fallbackAnalysis(imageUrl);
    }
}

// Function to check for upcoming races and send notifications
async function checkUpcomingRaces() {
    const currentTime = moment().tz('Australia/Melbourne');
    console.log(`🔍 Checking for 5-minute race alerts at ${currentTime.format('HH:mm:ss')}`);
    
    const notificationChannel = client.channels.cache.get('1401527867447443456');
    
    if (!notificationChannel) {
        console.log('❌ Notification channel not found');
        return;
    }
    
    // Check screenshot-based races
    for (const race of upcomingRaces) {
        const raceTime = moment(race.raceTime);
        const minutesUntilRace = raceTime.diff(currentTime, 'minutes');
        const raceKey = `${race.race}-${race.raceTime}`;
        
        // Send notification when race is 5 minutes away (and we haven't already notified)
        if (minutesUntilRace <= 5 && minutesUntilRace > 0 && !notificationsSent.has(raceKey)) {
            console.log(`🚨 Sending 5-minute notification for ${race.race}`);
            
            await notificationChannel.send({
                content: `@everyone 🏇 **Race Alert!**\n\n🚨 **${race.race} starts in ${minutesUntilRace} minutes!**\n\n⏰ **Start Time:** ${raceTime.format('HH:mm:ss')} Melbourne Time\n🏁 **Race:** ${race.raceName || 'Race details'}\n\nGet ready! 🎯`
            });
            
            notificationsSent.add(raceKey);
        }
        
        // Clean up old races (more than 10 minutes past)
        if (minutesUntilRace < -10) {
            const index = upcomingRaces.indexOf(race);
            if (index > -1) {
                upcomingRaces.splice(index, 1);
                notificationsSent.delete(raceKey);
            }
        }
    }
    
    // Check Japanese races from BetsAPI for 5-minute alerts
    try {
        const japaneseRaces = await getJapaneseRaces();
        console.log(`📊 Checking ${japaneseRaces.length} Japanese races for 5-minute alerts`);
        
        for (const race of japaneseRaces) {
            const raceTime = moment.unix(race.time).tz('Australia/Melbourne');
            const minutesUntilRace = raceTime.diff(currentTime, 'minutes');
            const raceKey = `japanese-${race.id}`;
            const raceName = race.league?.name || race.home?.name || 'Unknown Track';
            
            console.log(`🏇 ${raceName} - ${raceTime.format('HH:mm')} - ${minutesUntilRace}m until race`);
            
            // Send notification when Japanese race is 5 minutes away
            if (minutesUntilRace <= 5 && minutesUntilRace > 0 && !notificationsSent.has(raceKey)) {
                console.log(`🚨 Sending 5-minute notification for Japanese race: ${raceName}`);
                
                await notificationChannel.send({
                    content: `@everyone 🏇 **Japanese Race Alert!**\n\n🚨 **${raceName} starts in ${minutesUntilRace} minutes!**\n\n⏰ **Start Time:** ${raceTime.format('HH:mm:ss')} Melbourne Time\n🇯🇵 **Track:** ${raceName}\n📊 **Odds monitoring active**\n\nGet ready for live odds tracking! 🎯`
                });
                
                notificationsSent.add(raceKey);
                console.log(`✅ 5-minute alert sent for ${raceName}!`);
            } else if (minutesUntilRace <= 5 && minutesUntilRace > 0) {
                console.log(`⏭️  Alert already sent for ${raceName} (key: ${raceKey})`);
            }
            
            // Clean up old Japanese race notifications (more than 10 minutes past)
            if (minutesUntilRace < -10) {
                notificationsSent.delete(raceKey);
                console.log(`🧹 Cleaned up old notification for ${raceName}`);
            }
        }
        
    } catch (error) {
        console.error('❌ Error checking Japanese races for notifications:', error);
    }
}

// Function to add races to the notification system
function addRacesToNotifications(raceInfo) {
    const currentTime = moment().tz('Australia/Melbourne');
    
    raceInfo.raceTimes.forEach(race => {
        const raceTime = moment().tz('Australia/Melbourne');
        
        // Parse the race time
        if (race.countdownSeconds) {
            raceTime.add(race.countdownSeconds, 'seconds');
        } else if (race.countdownMinutes) {
            raceTime.add(race.countdownMinutes, 'minutes');
        } else if (race.timeUntilRace > 0) {
            raceTime.add(race.timeUntilRace, 'minutes');
        } else {
            return; // Skip races that have already started
        }
        
        // Only add races that are within the next 24 hours
        if (raceTime.diff(currentTime, 'hours') <= 24) {
            const raceKey = `${race.race}-${raceTime.toISOString()}`;
            
            // Check if this race is already in our list
            const existingRace = upcomingRaces.find(r => r.race === race.race && Math.abs(moment(r.raceTime).diff(raceTime, 'minutes')) < 2);
            
            if (!existingRace) {
                upcomingRaces.push({
                    race: race.race,
                    raceTime: raceTime.toISOString(),
                    raceName: race.original || 'Unknown Race',
                    addedAt: currentTime.toISOString()
                });
                
                console.log(`📅 Added ${race.race} to notifications: ${raceTime.format('HH:mm:ss')} Melbourne Time`);
            }
        }
    });
    
    console.log(`📊 Total races being monitored: ${upcomingRaces.length}`);
}

// Fallback analysis if AI fails
async function fallbackAnalysis(imageUrl) {
    console.log('🔄 Using fallback analysis');
    
    return {
        isRacing: true,
        analysis: 'Racing content detected! AI analysis unavailable - add your OpenAI API key for advanced features.',
        raceInfo: {
            raceTimes: [],
            countdown: 'Unable to determine without AI',
            currentMelbourneTime: moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')
        }
    };
}

// Parse race information and calculate times
function parseRaceInformation(analysis) {
    const raceTimes = [];
    const currentTime = moment().tz('Australia/Melbourne');
    let match;
    
    // Enhanced regex patterns for different countdown formats
    const countdownMinutesRegex = /R(\d+)[\s\S]*?Countdown:\s*(\d+)m/gi;
    const countdownSecondsRegex = /R(\d+)[\s\S]*?Countdown:\s*(\d+)s/gi;
    const scheduledInMinutesRegex = /R(\d+):\s*Scheduled in (\d+) minutes?/gi;
    const raceTimeRegex = /R(\d+)[\s\S]*?Time:\s*(\d{1,2}):(\d{2})/gi;
    
    // Extract countdown in minutes (R2: Countdown: 30m)
    while ((match = countdownMinutesRegex.exec(analysis)) !== null) {
        const raceNumber = match[1];
        const minutesFromNow = parseInt(match[2]);
        const raceTime = moment(currentTime).add(minutesFromNow, 'minutes');
        
        raceTimes.push({
            race: `R${raceNumber}`,
            original: `${minutesFromNow} minutes countdown`,
            time: raceTime.format('HH:mm'),
            melbourneTime: raceTime.format('YYYY-MM-DD HH:mm [AEDT/AEST]'),
            timeUntilRace: minutesFromNow,
            countdownMinutes: minutesFromNow
        });
    }
    
    // Extract countdown in seconds (R1: Countdown: 58s)
    while ((match = countdownSecondsRegex.exec(analysis)) !== null) {
        const raceNumber = match[1];
        const secondsFromNow = parseInt(match[2]);
        const minutesFromNow = Math.ceil(secondsFromNow / 60); // Convert to minutes for display
        const raceTime = moment(currentTime).add(secondsFromNow, 'seconds');
        
        raceTimes.push({
            race: `R${raceNumber}`,
            original: `${secondsFromNow} seconds countdown`,
            time: raceTime.format('HH:mm:ss'),
            melbourneTime: raceTime.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]'),
            timeUntilRace: minutesFromNow,
            countdownSeconds: secondsFromNow
        });
    }
    
    // Extract "Scheduled in X minutes" format
    while ((match = scheduledInMinutesRegex.exec(analysis)) !== null) {
        const raceNumber = match[1];
        const minutesFromNow = parseInt(match[2]);
        const raceTime = moment(currentTime).add(minutesFromNow, 'minutes');
        
        raceTimes.push({
            race: `R${raceNumber}`,
            original: `Scheduled in ${minutesFromNow} minutes`,
            time: raceTime.format('HH:mm'),
            melbourneTime: raceTime.format('YYYY-MM-DD HH:mm [AEDT/AEST]'),
            timeUntilRace: minutesFromNow,
            countdownMinutes: minutesFromNow
        });
    }
    
    // Extract race times (R1: Time: 13:50)
    while ((match = raceTimeRegex.exec(analysis)) !== null) {
        const raceNumber = match[1];
        const hour = parseInt(match[2]);
        const minute = parseInt(match[3]);
        
        const raceTime = moment().tz('Australia/Melbourne').hour(hour).minute(minute).second(0);
        
        // If the race time is in the past, add a day
        if (raceTime.isBefore(currentTime)) {
            raceTime.add(1, 'day');
        }
        
        // Only add if not already added by countdown patterns
        const alreadyExists = raceTimes.some(rt => rt.race === `R${raceNumber}`);
        if (!alreadyExists) {
            raceTimes.push({
                race: `R${raceNumber}`,
                original: `${hour}:${minute.toString().padStart(2, '0')}`,
                time: raceTime.format('HH:mm'),
                melbourneTime: raceTime.format('YYYY-MM-DD HH:mm [AEDT/AEST]'),
                timeUntilRace: raceTime.diff(currentTime, 'minutes')
            });
        }
    }
    
    // Sort by race number
    raceTimes.sort((a, b) => {
        const aNum = parseInt(a.race.replace('R', ''));
        const bNum = parseInt(b.race.replace('R', ''));
        return aNum - bNum;
    });
    
    return {
        raceTimes: raceTimes,
        currentMelbourneTime: currentTime.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')
    };
}

// Bot ready event
client.once('ready', () => {
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`🕐 Current Melbourne time: ${moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}`);
    console.log(`🔔 Notification system active - monitoring channel: 1401527867447443456`);
    console.log(`📊 Odds tracking active - odds channel: ${ODDS_CHANNEL_ID}`);
    
    // Set up race notification checker (every 30 seconds)
    setInterval(checkUpcomingRaces, 30000);
    console.log(`⏰ Race notification checker started (every 30 seconds)`);
    
    // Set up odds monitoring (every 15 seconds for more precise timing)
    if (BETSAPI_TOKEN) {
        setInterval(monitorOddsChanges, 15000);
        console.log(`💰 Odds monitoring started (every 15 seconds) with BetsAPI`);
    } else {
        console.log(`⚠️  BetsAPI token not found - odds tracking disabled`);
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
            content: `🤖 **Enhanced Racing Bot with AI Analysis & Notifications**\n\n📸 **Upload racing screenshots** and I'll analyze them!\n🏇 **I can detect:**\n• Race times and countdowns\n• Horse names and odds\n• Time until races start\n• Convert times to Melbourne timezone\n\n🔔 **Notification System:**\n• Automatically monitors race times\n• Sends @everyone alerts 5 minutes before races\n• Works across channels for maximum coverage\n\n� **Commands:**\n• \`!help\` - Show this help message\n• \`!races\` - Show current Japanese races being monitored\n• \`!status\` - Show bot status and configuration\n\n�🕐 **Current Melbourne Time:** ${melbourneTime}\n\n🤖 **AI Status:** ${hasOpenAI ? '✅ OpenAI Enabled' : '❌ Add OpenAI API key for advanced analysis'}\n\n*Just upload an image and I'll analyze it AND set up notifications!*`
        });
        return;
    }
    
    // Show current Japanese races command
    if (message.content.toLowerCase() === '!races') {
        console.log('🏇 Races command detected');
        
        try {
            const races = await getJapaneseRaces();
            const currentTime = moment().tz('Australia/Melbourne');
            
            if (races.length === 0) {
                await message.reply({
                    content: `🏇 **No Japanese Races Found**\n\n❌ No Japanese horse races are currently available from Bet365.\n\n🕐 **Current Melbourne Time:** ${currentTime.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}\n\n*The bot monitors these tracks: Morioka, Kanazawa, Kawasaki, Tokyo Keiba, Sonoda, Nagoya, Kochi, Saga, Mizusawa*`
                });
                return;
            }
            
            let responseText = `🏇 **Current Japanese Races Being Monitored**\n\n`;
            responseText += `📊 **Found ${races.length} Japanese races from Bet365:**\n\n`;
            
            // Group races by track
            const trackGroups = {};
            races.forEach(race => {
                const trackName = race.league?.name || race.home?.name || 'Unknown';
                if (!trackGroups[trackName]) {
                    trackGroups[trackName] = [];
                }
                trackGroups[trackName].push(race);
            });
            
            // Display races grouped by track
            Object.keys(trackGroups).forEach(trackName => {
                const trackRaces = trackGroups[trackName];
                responseText += `🏁 **${trackName}** (${trackRaces.length} races)\n`;
                
                trackRaces.forEach(race => {
                    const raceTime = moment.unix(race.time).tz('Australia/Melbourne');
                    const minutesUntil = raceTime.diff(currentTime, 'minutes');
                    const timeStatus = minutesUntil > 0 ? `${minutesUntil}m away` : 'Started';
                    
                    responseText += `  • ${raceTime.format('HH:mm')} (${timeStatus})\n`;
                });
                responseText += `\n`;
            });
            
            responseText += `🕐 **Current Melbourne Time:** ${currentTime.format('HH:mm:ss AEDT/AEST')}\n`;
            responseText += `🔄 **Next update:** Every 15 seconds\n`;
            responseText += `🚨 **Alerts:** 2min baseline → 10s before & 15s after race start`;
            
            await message.reply({ content: responseText });
            
        } catch (error) {
            console.error('❌ Error fetching races:', error);
            await message.reply({
                content: `❌ **Error fetching Japanese races**\n\nThere was an issue connecting to the Bet365 API. Please try again later.\n\n🕐 **Current Melbourne Time:** ${moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}`
            });
        }
        
        return;
    }
    
    // Show bot status command
    if (message.content.toLowerCase() === '!status') {
        console.log('🔧 Status command detected');
        
        const currentTime = moment().tz('Australia/Melbourne');
        const hasOpenAI = openai.apiKey && openai.apiKey !== 'demo-key';
        const hasBetsAPI = !!BETSAPI_TOKEN;
        
        let statusText = `🤖 **Bot Status Report**\n\n`;
        statusText += `🕐 **Current Time:** ${currentTime.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}\n`;
        statusText += `🔑 **API Status:**\n`;
        statusText += `  • Discord: ✅ Connected as ${client.user.tag}\n`;
        statusText += `  • OpenAI: ${hasOpenAI ? '✅ Connected' : '❌ Not configured'}\n`;
        statusText += `  • BetsAPI: ${hasBetsAPI ? '✅ Connected' : '❌ Not configured'}\n\n`;
        
        statusText += `🏇 **Racing Monitoring:**\n`;
        statusText += `  • Notification alerts: Every 30 seconds\n`;
        statusText += `  • Odds monitoring: Every 15 seconds\n`;
        statusText += `  • Upcoming races tracked: ${upcomingRaces.length}\n`;
        statusText += `  • 2-minute baselines stored: ${twoMinuteOdds.size}\n`;
        statusText += `  • Notifications sent: ${notificationsSent.size}\n\n`;
        
        statusText += `📡 **Channels:**\n`;
        statusText += `  • Odds alerts: <#${ODDS_CHANNEL_ID}>\n`;
        statusText += `  • Race notifications: <#${RACE_ALERTS_CHANNEL_ID}>\n\n`;
        
        statusText += `📋 **Commands:**\n`;
        statusText += `  • \`!help\` - Show help information\n`;
        statusText += `  • \`!races\` - Show current Japanese races\n`;
        statusText += `  • \`!status\` - Show this status report\n`;
        statusText += `  • \`!test\` - Test notification channel\n\n`;
        
        statusText += `🚀 **Bot is running on Railway deployment**`;
        
        await message.reply({ content: statusText });
        return;
    }
    
    // Test notification command
    if (message.content.toLowerCase() === '!test') {
        console.log('🧪 Test command detected');
        
        try {
            const notificationChannel = client.channels.cache.get('1401527867447443456');
            
            if (!notificationChannel) {
                await message.reply('❌ **Notification channel not found!** Bot cannot access channel 1401527867447443456');
                return;
            }
            
            await notificationChannel.send({
                content: `🧪 **Test Alert** 🧪\n\nThis is a test notification to verify the alert system is working.\n\n⏰ **Time:** ${moment().tz('Australia/Melbourne').format('HH:mm:ss')} Melbourne Time\n🤖 **Sent by:** ${message.author.username}\n\n✅ **If you see this, 5-minute race alerts should work!**`
            });
            
            await message.reply('✅ **Test notification sent!** Check channel <#1401527867447443456>');
            console.log('✅ Test notification sent successfully');
            
        } catch (error) {
            console.error('❌ Test notification failed:', error);
            await message.reply(`❌ **Test failed:** ${error.message}`);
        }
        
        return;
    }
    
    // Check if message has attachments
    if (message.attachments.size === 0) return;
    
    console.log('📸 Image detected, analyzing with AI...');
    
    // Process each attachment
    for (const attachment of message.attachments.values()) {
        // Check if attachment is an image
        if (!attachment.contentType?.startsWith('image/')) continue;
        
        try {
            // React to show we're processing
            await message.react('🤖');
            
            // Analyze image with AI
            const result = await analyzeRacingImageWithAI(attachment.url);
            
            console.log('📝 Analysis result:', result);
            
            if (result.isRacing) {
                // Create detailed response
                let responseText = `🏇 **Racing Screenshot Analyzed!**\n\n`;
                responseText += `🤖 **Analysis:**\n\`\`\`\n${result.analysis.substring(0, 400)}...\n\`\`\`\n\n`;
                
                if (result.raceInfo && result.raceInfo.raceTimes.length > 0) {
                    // Add races to notification system
                    addRacesToNotifications(result.raceInfo);
                    
                    responseText += `⏰ **Race Times (Melbourne):**\n`;
                    result.raceInfo.raceTimes.forEach(race => {
                        const timeLeft = race.timeUntilRace > 0 ? `${race.timeUntilRace} minutes` : 'Started';
                        const raceLabel = race.race ? `${race.race}: ` : '';
                        
                        let countdownInfo = '';
                        if (race.countdownSeconds) {
                            countdownInfo = ` (${race.countdownSeconds}s countdown)`;
                        } else if (race.countdownMinutes) {
                            countdownInfo = ` (${race.countdownMinutes}m countdown)`;
                        }
                        
                        responseText += `• ${raceLabel}${race.time} → ${race.melbourneTime} (${timeLeft})${countdownInfo}\n`;
                    });
                    responseText += `\n`;
                }
                
                responseText += `🕐 **Current Melbourne Time:** ${result.raceInfo?.currentMelbourneTime || moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}`;
                
                await message.reply({ content: responseText });
                await message.react('🏇');
                console.log('✅ AI racing analysis sent!');
            } else {
                await message.react('❌');
                console.log('❌ No racing content detected');
            }
            
        } catch (error) {
            console.error('❌ Error analyzing image:', error);
            await message.react('⚠️');
            await message.reply(`❌ Error analyzing image: ${error.message}`);
        }
    }
});

// ===========================
// BETSAPI INTEGRATION FUNCTIONS
// ===========================

// Function to get Japanese horse racing events from Bet365 via BetsAPI
async function getJapaneseRaces() {
    if (!BETSAPI_TOKEN) {
        console.log('⚠️ No BetsAPI token found - skipping odds tracking');
        return [];
    }

    try {
        console.log('🔍 Fetching Bet365 horse racing events...');
        
        // Use the working Bet365 endpoint
        const response = await axios.get('https://api.betsapi.com/v2/bet365/upcoming', {
            params: {
                token: BETSAPI_TOKEN,
                sport_id: 2 // Horse Racing
            }
        });

        if (response.data && response.data.results) {
            console.log(`📊 Found ${response.data.results.length} total Bet365 horse racing events`);
            
            // Filter for Japanese tracks
            const japaneseRaces = response.data.results.filter(race => {
                const leagueName = (race.league?.name || '').toLowerCase();
                const homeName = (race.home?.name || '').toLowerCase();
                const combinedName = (leagueName + ' ' + homeName).toLowerCase();
                
                const isJapanese = JAPANESE_TRACKS.some(track => 
                    combinedName.includes(track.toLowerCase()) || 
                    combinedName.includes('japan') ||
                    combinedName.includes('jra') ||
                    combinedName.includes('nar') ||
                    combinedName.includes('tokyo') ||
                    combinedName.includes('kyoto') ||
                    combinedName.includes('hanshin') ||
                    combinedName.includes('chukyo') ||
                    combinedName.includes('nakayama')
                );
                
                if (isJapanese) {
                    console.log(`🏇 Found Japanese race: ${race.league?.name || race.home?.name} (ID: ${race.id})`);
                }
                
                return isJapanese;
            });

            console.log(`🏇 Found ${japaneseRaces.length} Japanese races from Bet365`);
            
            // Log first few races for debugging
            if (response.data.results.length > 0) {
                console.log('📋 Sample Bet365 races found:');
                response.data.results.slice(0, 5).forEach(race => {
                    console.log(`  - ${race.league?.name || race.home?.name || 'Unknown'} (ID: ${race.id}, Time: ${race.time})`);
                });
            }
            
            return japaneseRaces;
        }
        
        return [];
    } catch (error) {
        console.error('❌ Error fetching Japanese races from Bet365 API:', error.message);
        
        if (error.response?.status === 403) {
            console.log('💡 Bet365 API 403 Error - Check your BetsAPI token permissions');
        }
        
        return [];
    }
}

// Function to get odds for a specific Bet365 race
async function fetchRaceOdds(raceId) {
    if (!BETSAPI_TOKEN) {
        return null;
    }

    try {
        console.log(`🎯 Fetching Bet365 odds for race ID: ${raceId}`);
        
        const response = await axios.get('https://api.betsapi.com/v1/bet365/event', {
            params: {
                token: BETSAPI_TOKEN,
                FI: raceId // Use the race ID as FI parameter
            }
        });

        if (response.data && response.data.results && response.data.results.length > 0) {
            console.log(`✅ Found ${response.data.results.length} betting markets for race ${raceId}`);
            
            // Look for win market specifically
            const winMarket = response.data.results.find(market => 
                market.type && (
                    market.type.toLowerCase().includes('winner') ||
                    market.type.toLowerCase().includes('win') ||
                    market.type.toLowerCase().includes('1st')
                )
            );
            
            if (winMarket && winMarket.odds) {
                console.log(`🏆 Found win market with ${winMarket.odds.length} horses`);
                return winMarket.odds;
            } else {
                // If no specific win market, return the first market with odds
                const firstMarketWithOdds = response.data.results.find(market => market.odds && market.odds.length > 0);
                if (firstMarketWithOdds) {
                    console.log(`📊 Using first available market with ${firstMarketWithOdds.odds.length} horses`);
                    return firstMarketWithOdds.odds;
                }
            }
        }
        
        console.log(`⚠️ No odds found for race ${raceId}`);
        return null;
    } catch (error) {
        console.error(`❌ Error fetching Bet365 odds for race ${raceId}:`, error.message);
        return null;
    }
}

// Function to send pre-race odds drop alerts (10 seconds before race)
async function sendPreRaceOddsDropAlert(race, drops, twoMinuteTimestamp) {
    try {
        const channel = await client.channels.fetch(ODDS_CHANNEL_ID);
        if (!channel) {
            console.log('❌ Odds alert channel not found');
            return;
        }

        const raceTime = moment.unix(race.time);
        const secondsUntil = raceTime.diff(moment().tz('Australia/Melbourne'), 'seconds');
        const raceName = race.league?.name || race.home?.name || 'Unknown Race';
        const twoMinuteTime = moment(twoMinuteTimestamp);

        let alertMessage = `🚨 **PRE-RACE ODDS DROPS ALERT!** 🚨\n\n`;
        alertMessage += `🏇 **Race**: ${raceName}\n`;
        alertMessage += `⏰ **Race Time**: ${raceTime.format('HH:mm')} (${secondsUntil}s away)\n`;
        alertMessage += `📊 **Analysis**: 2-min baseline (${twoMinuteTime.format('HH:mm:ss')}) → 10s before race\n\n`;
        alertMessage += `📉 **Horses with 20%+ Odds Drops:**\n`;

        drops.forEach(drop => {
            // Format horse display with prominent number
            let horseDisplay = `**${drop.horseName}**`;
            if (drop.horseNumber) {
                horseDisplay = `**🏇 #${drop.horseNumber} - ${drop.horseName}**`;
            }
            
            alertMessage += `• ${horseDisplay}\n`;
            alertMessage += `  └ ${drop.twoMinuteOdds} → ${drop.tenSecondOdds} (**${drop.dropPercentage}% drop**)\n`;
        });

        alertMessage += `\n🎯 **${drops.length} horse${drops.length > 1 ? 's have' : ' has'} significant pre-race movement!**`;
        alertMessage += `\n⚡ **Final moments - race starting soon!**`;

        // Create unique key to prevent duplicate alerts
        const alertKey = `${race.id}-prerace-${drops.map(d => d.horseName).join('-')}`;
        
        if (!oddsAlertsChannelSent.has(alertKey)) {
            await channel.send(alertMessage);
            oddsAlertsChannelSent.add(alertKey);
            console.log(`🔔 Sent pre-race odds drop alert for ${drops.length} horses in race ${race.id}`);
        }

    } catch (error) {
        console.error('❌ Error sending pre-race odds drop alert:', error);
    }
}

// Function to send post-race odds change alerts (15 seconds after race starts)
async function sendPostRaceOddsChangeAlert(race, changes, twoMinuteTimestamp, postRaceSeconds) {
    try {
        const channel = await client.channels.fetch(ODDS_CHANNEL_ID);
        if (!channel) {
            console.log('❌ Odds alert channel not found');
            return;
        }

        const raceTime = moment.unix(race.time);
        const raceName = race.league?.name || race.home?.name || 'Unknown Race';
        const twoMinuteTime = moment(twoMinuteTimestamp);

        let alertMessage = `🏃 **POST-RACE ODDS CHANGES!** 🚨\n\n`;
        alertMessage += `🏇 **Race**: ${raceName}\n`;
        alertMessage += `⏰ **Race Started**: ${raceTime.format('HH:mm')} (${postRaceSeconds}s ago)\n`;
        alertMessage += `📊 **Analysis**: 2-min baseline (${twoMinuteTime.format('HH:mm:ss')}) → ${postRaceSeconds}s into race\n\n`;
        alertMessage += `📈📉 **Horses with 20%+ Odds Changes During Race:**\n`;

        changes.forEach(change => {
            // Format horse display with prominent number
            let horseDisplay = `**${change.horseName}**`;
            if (change.horseNumber) {
                horseDisplay = `**🏇 #${change.horseNumber} - ${change.horseName}**`;
            }
            
            // Determine if odds shortened or drifted
            const movement = change.twoMinuteOdds > change.tenSecondOdds ? 'shortened' : 'drifted';
            const arrow = movement === 'shortened' ? '📉' : '📈';
            
            alertMessage += `${arrow} ${horseDisplay}\n`;
            alertMessage += `  └ ${change.twoMinuteOdds} → ${change.tenSecondOdds} (**${change.dropPercentage}% ${movement}**)\n`;
        });

        alertMessage += `\n🎯 **${changes.length} horse${changes.length > 1 ? 's show' : ' shows'} significant movement during race!**`;
        alertMessage += `\n🏃 **Live betting data - race in progress!**`;

        // Create unique key to prevent duplicate alerts
        const alertKey = `${race.id}-postrace-${changes.map(c => c.horseName).join('-')}`;
        
        if (!oddsAlertsChannelSent.has(alertKey)) {
            await channel.send(alertMessage);
            oddsAlertsChannelSent.add(alertKey);
            console.log(`🏃 Sent post-race odds change alert for ${changes.length} horses in race ${race.id}`);
        }

    } catch (error) {
        console.error('❌ Error sending post-race odds change alert:', error);
    }
}

// Main odds monitoring function
async function monitorOddsChanges() {
    try {
        const races = await getJapaneseRaces();
        const currentTime = moment().tz('Australia/Melbourne');
        
        for (const race of races) {
            const raceTime = moment.unix(race.time);
            const secondsUntilRace = raceTime.diff(currentTime, 'seconds');
            const minutesUntilRace = Math.floor(secondsUntilRace / 60);
            const raceKey = race.id; // Use ID as the unique identifier for Bet365
            
            // Store 2-minute baseline odds
            if (secondsUntilRace <= 125 && secondsUntilRace >= 115 && !twoMinuteOdds.has(raceKey)) {
                console.log(`📊 Capturing 2-minute baseline odds for race ${race.league?.name || race.home?.name} (ID: ${raceKey})`);
                const odds = await fetchRaceOdds(raceKey);
                if (odds && odds.length > 0) {
                    twoMinuteOdds.set(raceKey, {
                        odds: odds,
                        timestamp: currentTime.toISOString(),
                        race: race
                    });
                    console.log(`✅ Stored 2-minute baseline for race ${raceKey} with ${odds.length} horses`);
                }
            }
            
            // Check for pre-race odds drops (10 seconds before)
            if (secondsUntilRace <= 15 && secondsUntilRace >= 5 && twoMinuteOdds.has(raceKey)) {
                console.log(`🔍 Checking for pre-race odds drops for race ${raceKey}`);
                const currentOdds = await fetchRaceOdds(raceKey);
                const baseline = twoMinuteOdds.get(raceKey);
                
                if (currentOdds && baseline) {
                    const drops = compareOddsForDrops(baseline.odds, currentOdds, 20);
                    if (drops.length > 0) {
                        console.log(`🚨 Found ${drops.length} horses with 20%+ odds drops!`);
                        await sendPreRaceOddsDropAlert(race, drops, baseline.timestamp);
                    }
                }
            }
            
            // Check for post-race odds changes (15 seconds after race starts)
            if (secondsUntilRace <= -10 && secondsUntilRace >= -20 && twoMinuteOdds.has(raceKey)) {
                console.log(`🔍 Checking for post-race odds changes for race ${raceKey}`);
                const currentOdds = await fetchRaceOdds(raceKey);
                const baseline = twoMinuteOdds.get(raceKey);
                
                if (currentOdds && baseline) {
                    const changes = compareOddsForDrops(baseline.odds, currentOdds, 20);
                    if (changes.length > 0) {
                        console.log(`🏃 Found ${changes.length} horses with 20%+ odds changes during race!`);
                        await sendPostRaceOddsChangeAlert(race, changes, baseline.timestamp, Math.abs(secondsUntilRace));
                    }
                }
            }
            
            // Clean up old race data (more than 30 minutes past)
            if (secondsUntilRace < -1800) {
                twoMinuteOdds.delete(raceKey);
                console.log(`🧹 Cleaned up old race data for ${raceKey}`);
            }
        }
        
    } catch (error) {
        console.error('❌ Error in odds monitoring:', error);
    }
}

// Helper function to compare Bet365 odds and find significant drops/changes
function compareOddsForDrops(baselineOdds, currentOdds, thresholdPercent) {
    const drops = [];
    
    if (!baselineOdds || !currentOdds) return drops;
    
    // Create maps for easier comparison - Bet365 format uses 'na' for horse name and 'od' for odds
    const baselineMap = new Map();
    const currentMap = new Map();
    
    baselineOdds.forEach(bet => {
        if (bet.od && bet.na) {
            // Parse Bet365 odds format (e.g., "5/2", "2.50", "9/4")
            const parsedOdds = parseOddsValue(bet.od);
            if (parsedOdds > 0) {
                baselineMap.set(bet.na, parsedOdds);
            }
        }
    });
    
    currentOdds.forEach(bet => {
        if (bet.od && bet.na) {
            const parsedOdds = parseOddsValue(bet.od);
            if (parsedOdds > 0) {
                currentMap.set(bet.na, parsedOdds);
            }
        }
    });
    
    console.log(`📊 Comparing odds: ${baselineMap.size} baseline horses vs ${currentMap.size} current horses`);
    
    // Compare odds for each horse
    for (const [horseName, baselineOdd] of baselineMap) {
        const currentOdd = currentMap.get(horseName);
        
        if (currentOdd && baselineOdd > 0) {
            const changePercent = Math.abs(((baselineOdd - currentOdd) / baselineOdd) * 100);
            
            if (changePercent >= thresholdPercent) {
                // Extract horse number from name if present
                const horseNumberMatch = horseName.match(/(\d+)/);
                const horseNumber = horseNumberMatch ? horseNumberMatch[1] : null;
                
                drops.push({
                    horseName: horseName,
                    horseNumber: horseNumber,
                    twoMinuteOdds: formatOddsDisplay(baselineOdd),
                    tenSecondOdds: formatOddsDisplay(currentOdd),
                    dropPercentage: changePercent.toFixed(1)
                });
                
                console.log(`📉 ${horseName}: ${formatOddsDisplay(baselineOdd)} → ${formatOddsDisplay(currentOdd)} (${changePercent.toFixed(1)}% change)`);
            }
        }
    }
    
    return drops.sort((a, b) => parseFloat(b.dropPercentage) - parseFloat(a.dropPercentage));
}

// Helper function to parse various odds formats from Bet365
function parseOddsValue(oddsString) {
    if (!oddsString) return 0;
    
    const odds = oddsString.toString().trim();
    
    // Handle fractional odds (e.g., "5/2", "9/4")
    if (odds.includes('/')) {
        const [numerator, denominator] = odds.split('/').map(Number);
        if (denominator && denominator > 0) {
            return (numerator / denominator) + 1; // Convert to decimal odds
        }
    }
    
    // Handle decimal odds (e.g., "2.50", "3.75")
    const decimal = parseFloat(odds);
    if (!isNaN(decimal) && decimal > 0) {
        return decimal;
    }
    
    return 0;
}

// Helper function to format odds for display
function formatOddsDisplay(decimal) {
    if (decimal <= 1) return decimal.toFixed(2);
    
    // Convert back to fractional for better readability if it's a nice fraction
    const decimalPart = decimal - 1;
    
    // Try to convert to common fractions
    const fractions = [
        [0.5, '1/2'], [1, '1/1'], [1.5, '3/2'], [2, '2/1'],
        [2.5, '5/2'], [3, '3/1'], [3.5, '7/2'], [4, '4/1'],
        [0.25, '1/4'], [0.75, '3/4'], [1.25, '5/4'], [1.75, '7/4'],
        [0.33, '1/3'], [0.67, '2/3'], [1.33, '4/3'], [1.67, '5/3']
    ];
    
    for (const [dec, frac] of fractions) {
        if (Math.abs(decimalPart - dec) < 0.01) {
            return frac;
        }
    }
    
    return decimal.toFixed(2);
}

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
