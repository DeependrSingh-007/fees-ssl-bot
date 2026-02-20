# Fees (SSL Bot) - Live Ready

## Local Run
1) Install Node.js 18+ (recommended 20 LTS)
2) In this folder:
   npm install
3) Create `.env` (copy from .env.example) and set:
   OPENAI_API_KEY=...
   (optional) GEMINI_API_KEY=...
4) Start:
   npm start
5) Open:
   http://localhost:3000/library_fees.html

## Deploy on Render (Free)
1) Upload this project to GitHub (DO NOT upload .env)
2) Render.com -> New -> Web Service -> Connect repo
3) Build command: npm install
4) Start command: npm start
5) Environment variables (Render dashboard):
   OPENAI_API_KEY = your key
   (optional) GEMINI_API_KEY = your key
6) Deploy. Open:
   https://<your-app>.onrender.com/library_fees.html

## Notes
- Data files (data.json, archive.json, backups/) are stored on the server filesystem.
  On free platforms, storage can reset on redeploy. If you want permanent storage, use a DB later.
