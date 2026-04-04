#!/usr/bin/env node

/**
 * DSA Socket Server - Vercel Compatible
 * This version works on Vercel using HTTP polling transport
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { initializeHumanBuddyHandlers } = require('./lib/socket-handlers/human-buddy-handlers.js');

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// CORS for Vercel domains
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:4001',
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
].filter(Boolean);

console.log('[Socket Server] Allowed origins:', allowedOrigins);

// Socket.io configuration for Vercel (HTTP polling compatible)
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'], // Works with Vercel
  pingInterval: 25000,
  pingTimeout: 60000,
});

app.use(cors());
app.use(express.json());

// Initialize Firebase Admin for database operations (if available)
let firebaseDb = null;
try {
  const admin = require('firebase-admin');
  
  // Try to initialize with service account from environment
  let serviceAccount = null;
  
  // Method 1: FIREBASE_SERVICE_ACCOUNT as JSON string
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      console.log('[Server] Using FIREBASE_SERVICE_ACCOUNT env variable');
    } catch (err) {
      console.warn('[Server] Failed to parse FIREBASE_SERVICE_ACCOUNT:', err.message);
    }
  }
  
  // Method 2: Individual credential env variables
  if (!serviceAccount && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    try {
      // Handle private key - could be literal \n or escaped \\n
      let privateKey = process.env.FIREBASE_PRIVATE_KEY;
      
      // If it contains literal backslash-n, convert to actual newlines
      if (privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
      }
      
      serviceAccount = {
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        private_key_id: 'key-id',
        private_key: privateKey,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: 'client-id',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      };
      console.log('[Server] ✅ Using individual Firebase credential variables');
      console.log('[Server] ✅ Project ID:', serviceAccount.project_id);
      console.log('[Server] ✅ Client Email:', serviceAccount.client_email);
    } catch (err) {
      console.error('[Server] ❌ Error preparing Firebase credentials:', err.message);
    }
  }
  
  if (serviceAccount) {
    try {
      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
        });
        console.log('[Server] ✅ Firebase initialized ✓');
      } else {
        console.log('[Server] ✅ Firebase already initialized ✓');
      }
      firebaseDb = admin.firestore();
    } catch (initErr) {
      console.error('[Server] ❌ Firebase initialization error:', initErr.message);
      console.error('[Server] Error details:', initErr);
    }
  } else {
    console.warn('[Server] ⚠️  No Firebase credentials found');
    console.warn('[Server] Environment variables check:');
    console.warn('[Server]   - FIREBASE_PRIVATE_KEY exists:', !!process.env.FIREBASE_PRIVATE_KEY);
    console.warn('[Server]   - FIREBASE_CLIENT_EMAIL exists:', !!process.env.FIREBASE_CLIENT_EMAIL);
    console.warn('[Server]   - FIREBASE_PROJECT_ID exists:', !!process.env.FIREBASE_PROJECT_ID);
  }
} catch (error) {
  console.error('[Server] ❌ Firebase setup failed:', error.message);
  console.error('[Server] Stack:', error.stack);
}

// Initialize Human Buddy Mode handlers (requires Firebase)
try {
  initializeHumanBuddyHandlers(io, firebaseDb);
  console.log('[Server] Human Buddy handlers initialized ✓');
} catch (error) {
  console.warn('[Server] Failed to initialize buddy handlers:', error.message);
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'DSA Socket Server is running ✓' });
});

app.get('/health', (req, res) => {
  res.json({ healthy: true });
});

// In-memory room storage
const rooms = new Map();
const userSockets = new Map(); // Track userId -> socketId
const socketUsers = new Map();  // Track socketId -> userId

// Socket event handlers
io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);

  // CREATE ROOM
  socket.on('create_room', (data) => {
    const { userId, username, roomCode } = data;
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store room
    rooms.set(roomId, {
      roomCode,
      ownerId: userId,
      ownerUsername: username,
      ownerSocketId: socket.id,
      approvedMembers: [],
      pendingRequests: [],
      createdAt: new Date(),
    });

    userSockets.set(userId, socket.id);
    socketUsers.set(socket.id, { userId, username, roomId });

    socket.join(`room_${roomId}`);
    socket.emit('room_created', { success: true, roomId, roomCode });

    console.log(`[Socket] Room created: ${roomCode}`);
  });

  // REQUEST JOIN ROOM
  socket.on('request_join_room', (data) => {
    const { userId, username, roomCode } = data;
    
    // Store user socket mapping
    userSockets.set(userId, socket.id);
    socketUsers.set(socket.id, userId);
    
    // Find room
    let foundRoom = null;
    let foundRoomId = null;
    for (const [roomId, room] of rooms.entries()) {
      if (room.roomCode === roomCode) {
        foundRoom = room;
        foundRoomId = roomId;
        break;
      }
    }

    if (!foundRoom) {
      socket.emit('join_response', { success: false, message: 'Room not found' });
      return;
    }

    // Add to pending
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    foundRoom.pendingRequests.push({ id: requestId, userId, username, requestedAt: new Date() });

    socket.emit('join_response', { success: true, roomId: foundRoomId, roomCode });

    // Notify room owner
    const ownerSocket = io.sockets.sockets.get(foundRoom.ownerSocketId);
    if (ownerSocket) {
      ownerSocket.emit('member_request', { id: requestId, userId, username });
      ownerSocket.emit('members_list', {
        approved: foundRoom.approvedMembers,
        pending: foundRoom.pendingRequests,
        pendingCount: foundRoom.pendingRequests.length,
      });
      ownerSocket.emit('room_notification', {
        type: 'join_request',
        message: `${username} wants to join your room`,
        pendingCount: foundRoom.pendingRequests.length,
      });
    }

    console.log(`[Socket] Join request: ${username} (${userId}) → ${roomCode}`);
  });

  // APPROVE MEMBER
  socket.on('approve_member', (data) => {
    const { requestId, memberId, roomId } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    const reqIdx = room.pendingRequests.findIndex((r) => r.id === requestId);
    if (reqIdx === -1) return;

    const request = room.pendingRequests[reqIdx];
    const approvedUserId = request.userId;
    
    room.pendingRequests.splice(reqIdx, 1);
    room.approvedMembers.push({ userId: request.userId, username: request.username });

    // Find the approved user's socket and send them direct approval + members list
    const approvedUserSocketId = userSockets.get(approvedUserId);
    if (approvedUserSocketId) {
      const approvedUserSocket = io.sockets.sockets.get(approvedUserSocketId);
      if (approvedUserSocket) {
        approvedUserSocket.emit('join_approved', { 
          success: true,
          roomId,
          userId: approvedUserId,
          username: request.username,
          members: room.approvedMembers,
          memberCount: room.approvedMembers.length + 1, // +1 for owner
        });
        console.log(`[Socket] Sent join_approved to ${request.username}`);
      }
    }

    // Notify all in room that member joined
    io.to(`room_${roomId}`).emit('member_joined', { 
      userId: request.userId, 
      username: request.username 
    });

    // Update EVERYONE's members list (both owner and newly approved member)
    io.to(`room_${roomId}`).emit('members_list', {
      approved: room.approvedMembers,
      pending: room.pendingRequests,
      memberCount: room.approvedMembers.length + 1, // +1 for owner
    });

    const ownerSocket = io.sockets.sockets.get(room.ownerSocketId);
    if (ownerSocket) {
      ownerSocket.emit('members_list', {
        approved: room.approvedMembers,
        pending: room.pendingRequests,
        memberCount: room.approvedMembers.length + 1,
      });
    }

    console.log(`[Socket] Approved: ${request.username} (total members: ${room.approvedMembers.length + 1})`);
  });

  // REJECT MEMBER
  socket.on('reject_member', (data) => {
    const { requestId, roomId } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    const reqIdx = room.pendingRequests.findIndex((r) => r.id === requestId);
    if (reqIdx === -1) return;

    const request = room.pendingRequests[reqIdx];
    room.pendingRequests.splice(reqIdx, 1);

    const ownerSocket = io.sockets.sockets.get(room.ownerSocketId);
    if (ownerSocket) {
      ownerSocket.emit('members_list', {
        approved: room.approvedMembers,
        pending: room.pendingRequests,
      });
    }

    console.log(`[Socket] Rejected: ${request.username}`);
  });

  // GET ROOM STATE (for newly joined members)
  socket.on('get_room_state', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('room_state', { success: false, message: 'Room not found' });
      return;
    }

    // Send current room state to the user
    socket.emit('room_state', {
      success: true,
      roomId,
      roomCode: room.roomCode,
      ownerUsername: room.ownerUsername,
      members: room.approvedMembers,
      memberCount: room.approvedMembers.length + 1, // +1 for owner
      pending: room.pendingRequests,
    });

    console.log(`[Socket] Sent room state for ${roomId}`);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    // Clean up user socket mappings
    const userId = socketUsers.get(socket.id);
    if (userId) {
      userSockets.delete(userId);
    }
    socketUsers.delete(socket.id);
    
    console.log(`[Socket] User disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ DSA Socket Server running on port ${PORT}`);
  console.log(`✓ CORS enabled for:`, allowedOrigins);
  console.log(`✓ Transports: WebSocket + HTTP Polling`);
  console.log(`✓ Ready for connections!\n`);
});

module.exports = { io, app };
