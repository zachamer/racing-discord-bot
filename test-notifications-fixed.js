const { Client, GatewayIntentBits } = require('discord.js');
const moment = require('moment-timezone');
require('dotenv').config();

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Test notification system with fake race data - USE MAIN CHANNEL
async function testNotifications() {
    console.log('🧪 Testing notification system with fake race data...');
    
    const currentTime = moment().tz('Australia/Melbourne');
    console.log(`🕐 Current Melbourne time: ${currentTime.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')}`);
    
    // Create fake race times - 3 minutes and 6 minutes from now (shorter for faster testing)
    const race1Time = moment(currentTime).add(3, 'minutes');
    const race2Time = moment(currentTime).add(6, 'minutes');
    
    // Simulate AI analysis result with fake race data
    const fakeRaceData = {
        isRacing: true,
        analysis: 'TEST: Fake racing data for notification testing',
        raceInfo: {
            raceTimes: [
                {
                    race: 'R1',
                    original: 'Test Race 1 - 3 minutes from now',
                    time: race1Time.format('HH:mm:ss'),
                    melbourneTime: race1Time.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]'),
                    timeUntilRace: 3,
                    countdownMinutes: 3,
                    raceName: 'Test Race 1 - Melbourne Cup Qualifier'
                },
                {
                    race: 'R2', 
                    original: 'Test Race 2 - 6 minutes from now',
                    time: race2Time.format('HH:mm:ss'),
                    melbourneTime: race2Time.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]'),
                    timeUntilRace: 6,
                    countdownMinutes: 6,
                    raceName: 'Test Race 2 - Golden Slipper Stakes'
                }
            ],
            currentMelbourneTime: currentTime.format('YYYY-MM-DD HH:mm:ss [AEDT/AEST]')
        }
    };
    
    console.log('📊 Fake race data created:');
    fakeRaceData.raceInfo.raceTimes.forEach(race => {
        console.log(`   🏇 ${race.race}: ${race.raceName} at ${race.time} (${race.timeUntilRace} minutes away)`);
    });
    
    return fakeRaceData;
}

// Simulate the addRacesToNotifications function
const upcomingRaces = [];
const notificationsSent = new Set();

function addRacesToNotifications(raceInfo) {
    const currentTime = moment().tz('Australia/Melbourne');
    
    raceInfo.raceTimes.forEach(race => {
        const raceTime = moment().tz('Australia/Melbourne');
        
        // Parse the race time based on available data
        if (race.countdownSeconds) {
            raceTime.add(race.countdownSeconds, 'seconds');
        } else if (race.countdownMinutes) {
            raceTime.add(race.countdownMinutes, 'minutes');
        } else if (race.timeUntilRace > 0) {
            raceTime.add(race.timeUntilRace, 'minutes');
        }
        
        // Only add races that are in the future
        if (raceTime.isAfter(currentTime)) {
            const raceData = {
                race: race.race,
                raceName: race.raceName || 'Unknown Race',
                raceTime: raceTime,
                addedAt: currentTime.format()
            };
            
            upcomingRaces.push(raceData);
            console.log(`📅 Added ${race.race} (${race.raceName}) to notifications: ${raceTime.format('HH:mm:ss')} Melbourne Time`);
        }
    });
    
    console.log(`📊 Total races being monitored: ${upcomingRaces.length}`);
}

// Check for races that need notifications - USING MAIN CHANNEL FOR TESTING
async function checkUpcomingRaces() {
    if (upcomingRaces.length === 0) return;
    
    const currentTime = moment().tz('Australia/Melbourne');
    // Use the main channel instead of notification channel for testing
    const notificationChannel = client.channels.cache.get(process.env.CHANNEL_ID);
    
    if (!notificationChannel) {
        console.log('❌ Main channel not found');
        return;
    }
    
    console.log(`🔍 Checking ${upcomingRaces.length} races for notifications at ${currentTime.format('HH:mm:ss')}`);
    
    for (const race of upcomingRaces) {
        const raceTime = moment(race.raceTime);
        const minutesUntilRace = raceTime.diff(currentTime, 'minutes', true);
        const raceKey = `${race.race}-${raceTime.format('YYYY-MM-DD-HH-mm')}`;
        
        console.log(`   🏇 ${race.race}: ${minutesUntilRace.toFixed(1)} minutes until start`);
        
        // Send notification when race is 2 minutes away (changed from 5 for faster testing)
        if (minutesUntilRace <= 2 && minutesUntilRace > 0 && !notificationsSent.has(raceKey)) {
            console.log(`🚨 Sending 2-minute notification for ${race.race} (TESTING)`);
            
            await notificationChannel.send({
                content: `🧪 **TEST NOTIFICATION** @everyone 🏇 **Race Alert!**\n\n🚨 **${race.race} starts in ${Math.ceil(minutesUntilRace)} minutes!**\n\n⏰ **Start Time:** ${raceTime.format('HH:mm:ss')} Melbourne Time\n🏁 **Race:** ${race.raceName}\n\nGet ready! 🎯\n\n*This is a test of the notification system*`
            });
            
            notificationsSent.add(raceKey);
        }
        
        // Clean up old races (more than 10 minutes past)
        if (minutesUntilRace < -10) {
            const index = upcomingRaces.indexOf(race);
            if (index > -1) {
                upcomingRaces.splice(index, 1);
                notificationsSent.delete(raceKey);
                console.log(`🗑️ Removed old race: ${race.race}`);
            }
        }
    }
}

// Bot ready event
client.once('ready', async () => {
    console.log(`✅ Test Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`🔔 Testing notifications in main channel: ${process.env.CHANNEL_ID}`);
    
    // Generate fake race data
    const fakeData = await testNotifications();
    
    // Add fake races to notification system
    addRacesToNotifications(fakeData.raceInfo);
    
    // Set up notification checker (every 15 seconds for faster testing)
    setInterval(checkUpcomingRaces, 15000);
    console.log(`⏰ Race notification checker started (every 15 seconds)`);
    
    console.log('\n🎯 **Test Plan:**');
    console.log('   • R1 will trigger @everyone notification when it hits 2-minute mark');
    console.log('   • R2 will trigger @everyone notification when it hits 2-minute mark');
    console.log('   • Notifications will appear in your main channel for testing!');
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
