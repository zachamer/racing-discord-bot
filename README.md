# 🏇 Racing Discord Bot with AI Analysis & Notifications

A powerful Discord bot that analyzes racing screenshots from bet365 and sends automated notifications before races start.

## ✨ Features

- **AI-Powered Analysis**: Uses OpenAI Vision API to analyze racing screenshots
- **Melbourne Timezone**: Automatically converts all times to Melbourne (AEDT/AEST)
- **Smart Notifications**: Sends @everyone alerts 5 minutes before races start
- **Multi-Format Support**: Handles various countdown formats (seconds, minutes)
- **Cross-Channel**: Works across multiple Discord channels

## 🚀 Quick Start

1. Upload racing screenshots to Discord
2. Bot automatically analyzes and extracts race data
3. Notifications sent 5 minutes before each race starts

## 🛠️ Environment Variables

Create a `.env` file with:

```env
DISCORD_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
CHANNEL_ID=your_monitoring_channel_id
NOTIFICATION_CHANNEL_ID=your_notification_channel_id
```

## 📝 Commands

- `!help` - Show bot features and status
- Upload any racing image - Automatic analysis

## 🔧 Local Development

```bash
npm install
npm start
```

## 🌐 Deploy to Railway

1. Fork this repository
2. Connect to Railway
3. Add environment variables
4. Deploy automatically

## 📊 Race Analysis

The bot can detect:
- Race numbers (R1, R2, etc.)
- Countdown timers (58s, 30m formats)
- Race start times
- Convert to Melbourne timezone
- Set up automatic notifications

## 🔔 Notification System

- Monitors races every 30 seconds
- Sends alerts 5 minutes before start
- Prevents duplicate notifications
- Automatic cleanup of old races
