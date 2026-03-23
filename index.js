#!/usr/bin/env node

/**
 * DSA Socket Server - Vercel Compatible
 * This version works on Vercel using HTTP polling transport
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'DSA Socket Server is running ✓' });
});

app.get('/health', (req, res) => {
  res.json({ healthy: true });
});

// In-memory room storage
const rooms = new Map();
const userSockets = new Map();
const socketUsers = new Map();

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

    console.log(`[Socket] Join request: ${username} → ${roomCode}`);
  });

  // APPROVE MEMBER
  socket.on('approve_member', (data) => {
    const { requestId, memberId, roomId } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    const reqIdx = room.pendingRequests.findIndex((r) => r.id === requestId);
    if (reqIdx === -1) return;

    const request = room.pendingRequests[reqIdx];
    room.pendingRequests.splice(reqIdx, 1);
    room.approvedMembers.push({ userId: request.userId, username: request.username });

    // Notify all
    io.to(`room_${roomId}`).emit('member_joined', { userId: request.userId, username: request.username });

    const ownerSocket = io.sockets.sockets.get(room.ownerSocketId);
    if (ownerSocket) {
      ownerSocket.emit('members_list', {
        approved: room.approvedMembers,
        pending: room.pendingRequests,
      });
    }

    console.log(`[Socket] Approved: ${request.username}`);
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

  // DISCONNECT
  socket.on('disconnect', () => {
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
