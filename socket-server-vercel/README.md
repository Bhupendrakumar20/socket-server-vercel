# AI Interview Socket Server

Real-time Socket.io server for DSA room features. Vercel compatible using HTTP polling.

## Quick Start

### Local Development

```bash
npm install
npm run dev
```

Server runs on `http://localhost:3001`

### Deploy to Vercel

1. Create GitHub repo: `ai-interview-socket-server`
2. Push this code to GitHub
3. Go to vercel.com → Add New → Project
4. Import GitHub repo
5. Deploy!

## Configuration

### Environment Variables

Set in Vercel:
```
NEXT_PUBLIC_APP_URL = https://your-main-app.vercel.app
```

The server will automatically:
- Accept WebSocket connections
- Fall back to HTTP polling on Vercel
- Allow CORS from localhost and production domains

## Socket Events

### Server Emits
- `room_created` - Room successfully created
- `join_response` - Response to join request
- `member_request` - New member requesting to join
- `members_list` - Updated members list
- `member_joined` - Member approved and joined
- `room_notification` - General notifications

### Server Accepts
- `create_room` - Create a new DSA room
- `request_join_room` - Request to join a room
- `approve_member` - Approve a pending member
- `reject_member` - Reject a pending member

## Troubleshooting

### Won't connect on Vercel
- Check `NEXT_PUBLIC_APP_URL` env var is set
- Verify frontend is trying to connect to correct URL
- Check Vercel logs for errors

### CORS errors
- Make sure main app domain is in `allowedOrigins`
- Restart/redeploy socket server

### Rooms disappear after restart
- In-memory storage is cleared on restart
- For production, consider using Redis or database

## Architecture

- **Transport**: WebSocket (primary) + HTTP Polling (fallback for Vercel)
- **Storage**: In-memory (Map objects)
- **Framework**: Express.js + Socket.io
- **Deployment**: Vercel Node.js runtime
