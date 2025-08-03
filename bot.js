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
                                "countdownMinutes": 25
                            }
                        ]
                    }
                    
                    Rules:
                    - race: Use format like "R1", "R2", etc. or track name
                    - time: 24-hour format HH:MM
                    - countdownMinutes: numeric minutes until race starts
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
                    raceName: race.original || race.time || 'Unknown Race',
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
            races: [],
            currentMelbourneTime: moment().tz('Australia/Melbourne').format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')
        }
    };
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
                const message = `🔔 @everyone **RACE ALERT!**\n\n🏇 **${race.race}** starts in **${minutesUntilRace} minutes**!\n⏰ Race time: ${raceTime.format('HH:mm')} Melbourne time\n\n🎯 Get ready to place your bets!`;
                
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
            content: `🤖 **Enhanced Racing Bot with AI Analysis & Notifications**\n\n📸 **Upload racing screenshots** and I'll analyze them!\n🏇 **I can detect:**\n• Race times and countdowns\n• Horse names and odds\n• Time until races start\n• Convert times to Melbourne timezone\n\n🔔 **Notification System:**\n• Automatically monitors race times\n• Sends @everyone alerts 5 minutes before races\n• Works across channels for maximum coverage\n\n🕐 **Current Melbourne Time:** ${melbourneTime}\n\n🤖 **AI Status:** ${hasOpenAI ? '✅ OpenAI Enabled' : '❌ Add OpenAI API key for advanced analysis'}\n\n**Commands:**\n• \`!clear\` - Remove all race notifications\n• \`!status\` - Show active notifications\n\n*Just upload an image and I'll analyze it AND set up notifications!*`
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
            
            upcomingRaces.forEach((race, index) => {
                const raceTime = moment(race.raceTime);
                const minutesUntil = raceTime.diff(moment().tz('Australia/Melbourne'), 'minutes');
                const alertTime = moment(race.raceTime).subtract(5, 'minutes');
                
                statusText += `🏇 **${race.race}** - ${raceTime.format('HH:mm')}\n`;
                statusText += `   ⏰ Alert in ${Math.max(0, minutesUntil - 5)} minutes (${alertTime.format('HH:mm')})\n\n`;
            });
            
            statusText += `🔄 Use \`!clear\` to remove all notifications`;
            await message.reply(statusText);
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
