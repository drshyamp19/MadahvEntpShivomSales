# Antigravity Rules & Project Guidelines - Madhav Enterprises & Shivom Sales

These core guidelines apply strictly across all chats, sessions, and code updates for this project.

## 1. Core Operating Principles (Mandatory)
1. **No Reverting Changes (Forward-Only Progress)**: Never revert, rollback, or erase previously completed changes and features unless explicitly requested. Always fix, improve, or build forward on top of existing code.
2. **App Language, UI & Code in English**: All application code, variables, comments, HTML, UI labels, buttons, modals, and screen text MUST strictly be in English.
3. **Marathi Conversation**: The conversational interface with the user MUST strictly remain in Marathi (मराठी संवाद).
4. **Immediate Git Push for Automatic Cloudflare Live Deployment**: After every successful code modification or feature addition, immediately stage (`git add .`), commit with a descriptive message (`git commit -m "..."`), and push to `origin main` so that GitHub Actions automatically builds and deploys to Cloudflare Workers (`madhav-enterprises.mserp.workers.dev` and `shivom-sales`) live immediately without asking the user.
5. **Web and Mobile App Synchronization**: Since the Android APK is a WebView wrapper loading `https://madhav-enterprises.mserp.workers.dev` directly, all Cloudflare Worker deployments reflect instantly on both Web and Mobile App.

## 2. Completion Signal Rule
- **Last Line Requirement**: At the conclusion of every response where an action, update, or task is completed, always conclude on the very last line with:
  `Task is completed. ✅`
