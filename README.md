# Simple Discord Racing Bot

A simple Discord bot that analyzes racing screenshots and sends notifications.

## Setup

1. **Install dependencies:**
   ```
   npm install
   ```

2. **Create a Discord bot:**
   - Go to https://discord.com/developers/applications
   - Create a new application
   - Go to "Bot" section
   - Copy the token

3. **Configure environment:**
   - Create a `.env` file with: `DISCORD_TOKEN=your_discord_bot_token_here`

4. **Invite bot to your server:**
   - Go to OAuth2 > URL Generator
   - Select "bot" scope
   - Select "Send Messages", "Read Message History", "Add Reactions" permissions
   - Use the generated URL to invite bot

5. **Run the bot:**
   ```
   npm start
   ```

## How it works

- Upload any image to a Discord channel where the bot has access
- The bot will analyze the image using OCR (Optical Character Recognition)
- If racing-related content is detected, it will send a notification
- Use `!help` command for more information

## Features

- 🏇 Detects racing screenshots automatically
- 📝 Extracts text from images using OCR
- 🔔 Sends notifications when racing content is found
- ⚡ Simple and lightweight

*This is a basic implementation that you can enhance further.*

- Read Messages
- Send Messages
- Read Message History
- Attach Files
- Use External Emojis

## Commands

- `!races` - Show today's parsed races
- `!stats` - Show bot statistics
- `!help` - Show available commands
