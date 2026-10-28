# BattleHub production deployment

1. Push this folder to a private Git repository.
2. In Render, create a Blueprint from `render.yaml`.
3. Set Razorpay test or live credentials in Render environment variables.
4. Generate a strong random `ADMIN_TOKEN` and store it only in Render and the admin password manager.
5. Point battlehubarena.onrender.com to Render as configured and verify HTTPS.
6. Do not enable live cash tournaments until business KYC, skill-game legal review, age controls and withdrawal rules are approved.
7. Payments are credited only after Razorpay server-side signature verification.

Never commit Razorpay secrets, admin tokens or production keys.