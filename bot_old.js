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
    const notificationChannel = client.channels.cache.get('1401527867447443456');
    
    if (!notificationChannel) {
        console.log('❌ Notification channel not found');
        return;
    }
    
    // Check each upcoming race
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
    
    // Set up race notification checker (every 30 seconds)
    setInterval(checkUpcomingRaces, 30000);
    console.log(`⏰ Race notification checker started (every 30 seconds)`);
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
            content: `🤖 **Enhanced Racing Bot with AI Analysis & Notifications**\n\n📸 **Upload racing screenshots** and I'll analyze them!\n🏇 **I can detect:**\n• Race times and countdowns\n• Horse names and odds\n• Time until races start\n• Convert times to Melbourne timezone\n\n� **Notification System:**\n• Automatically monitors race times\n• Sends @everyone alerts 5 minutes before races\n• Works across channels for maximum coverage\n\n�🕐 **Current Melbourne Time:** ${melbourneTime}\n\n🤖 **AI Status:** ${hasOpenAI ? '✅ OpenAI Enabled' : '❌ Add OpenAI API key for advanced analysis'}\n\n*Just upload an image and I'll analyze it AND set up notifications!*`
        });
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

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
