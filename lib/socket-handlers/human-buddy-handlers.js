// ┌─────────────────────────────────────────────────────────────────────────┐
// │  Socket.io Event Handlers for Human Buddy Mode Interview                │
// │  FILE: lib/socket-handlers/human-buddy-handlers.js                      │
// │  Manages video calls, audio, screen sharing, and role assignment        │
// └─────────────────────────────────────────────────────────────────────────┘

// Note: Firebase admin is passed in as a parameter from index.js
// We'll use a mock db if Firebase is not available

const BUDDY_SESSION_STATUS = {
  CREATED: 'created',
  WAITING: 'waiting',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
};

const BUDDY_ROLES = {
  OWNER: 'owner',
  INTERVIEWER: 'interviewer',
  INTERVIEWEE: 'interviewee',
  WAITING: 'waiting',
};

/**
 * Initialize Human Buddy Mode Socket.io handlers
 * Call this in your Socket.io server setup
 * @param {Server} io - Socket.io instance
 * @param {object} firebaseDb - Firebase Firestore instance (optional)
 */
function initializeHumanBuddyHandlers(io, firebaseDb) {
  const buddyNamespace = io.of('/interview-buddy');
  const db = firebaseDb;

  buddyNamespace.on('connection', (socket) => {
    console.log(`[Buddy Mode] User connected: ${socket.id}`);
    console.log(`[Buddy Mode] Total connections in namespace: ${buddyNamespace.sockets.size}`);

    // ─── JOIN SESSION ────────────────────────────────────────────────────

    /**
     * User joins or creates a buddy session
     * Emitted by: Client when entering human buddy mode
     */
    socket.on('join_session', async (data) => {
      try {
        const { userId, username, sessionCode, isCreator } = data;
        console.log(`\n━━━ [join_session] START ━━━`);
        console.log(`📍 User: ${username} (${userId})`);
        console.log(`🔑 SessionCode: ${sessionCode}`);
        console.log(`👤 IsCreator: ${isCreator}`);
        console.log(`🔌 SocketId: ${socket.id}`);

        if (!userId || !sessionCode) {
          console.error('❌ Missing userId or sessionCode');
          socket.emit('error', { message: 'Missing userId or sessionCode' });
          return;
        }

        // Find session in Firestore
        console.log(`🔍 Querying Firestore for sessionCode: ${sessionCode}`);
        const sessionQuery = await db
          .collection('interview_buddy_sessions')
          .where('sessionCode', '==', sessionCode)
          .limit(1)
          .get();

        if (sessionQuery.empty) {
          console.error(`❌ No session found with code: ${sessionCode}`);
          socket.emit('error', { message: 'Session not found' });
          return;
        }

        const sessionDoc = sessionQuery.docs[0];
        const sessionData = sessionDoc.data();
        const sessionId = sessionDoc.id;

        console.log(`✅ Found session in Firestore`);
        console.log(`📄 SessionId: ${sessionId}`);
        console.log(`👥 Current participants: ${JSON.stringify(sessionData.participants)}`);
        console.log(`📊 Participant count: ${sessionData.participants.length}`);

        // ✅ ENFORCE 2-MEMBER LIMIT
        if (sessionData.participants.length >= 2) {
          console.error(`❌ Session is full (${sessionData.participants.length} members)`);
          socket.emit('error', { 
            message: 'Session is full. Only 2 members can join.',
            memberCount: sessionData.participants.length
          });
          return;
        }

        // Check if already in session
        if (sessionData.participants.includes(userId)) {
          console.error(`❌ User ${userId} already in this session`);
          socket.emit('error', { message: 'User already in this session' });
          return;
        }

        // ✅ ASSIGN ROLE: Owner keeps owner role, second person is interviewer/interviewee
        let role = BUDDY_ROLES.WAITING;
        if (isCreator) {
          role = BUDDY_ROLES.OWNER;
        } else if (sessionData.participants.length === 1) {
          // Second member joining - role assignment pending from owner
          role = BUDDY_ROLES.WAITING;
        }

        console.log(`👔 Assigned role: ${role}`);

        // Update session with new participant
        const updatedParticipants = [...sessionData.participants, userId];
        console.log(`💾 Updating Firestore - new participants: ${JSON.stringify(updatedParticipants)}`);
        
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          participants: updatedParticipants,
          [`participants_${userId}`]: {
            joinedAt: new Date(),
            role: role,
            name: username,
            camera: false,
            mic: false,
            screenShare: false,
          },
          status: sessionData.participants.length === 1 
            ? BUDDY_SESSION_STATUS.IN_PROGRESS 
            : sessionData.status,
          participantCount: updatedParticipants.length,
        });

        console.log(`✅ Firestore updated successfully`);

        // Store socket data
        socket.data = {
          sessionId,
          sessionCode,
          userId,
          username,
          role,
          isCreator,
        };

        // Join socket.io room - CRITICAL: Both users must use SAME room name
        const roomName = `buddy_${sessionId}`;
        socket.join(roomName);
        
        console.log(`🚪 Joined socket.io room: ${roomName}`);
        console.log(`👥 Users in room: ${socket.adapter.rooms.get(roomName)?.size || 0}`);

        // Send session state to joining user
        const updatedSession = (await db.collection('interview_buddy_sessions').doc(sessionId).get()).data();
        
        // 🔥 Build remoteUsers array - all OTHER participants
        const remoteUsers = updatedParticipants
          .filter(pid => pid !== userId) // Exclude self
          .map(pid => ({
            userId: pid,
            username: updatedSession[`participants_${pid}`]?.name || `User ${pid}`,
            camera: updatedSession[`participants_${pid}`]?.camera || false,
            mic: updatedSession[`participants_${pid}`]?.mic || false,
            screenShare: updatedSession[`participants_${pid}`]?.screenShare || false,
          }));
        
        console.log(`👥 Remote users for ${username}: ${JSON.stringify(remoteUsers)}`);
        
        socket.emit('session_joined', {
          sessionId,
          sessionCode,
          participants: updatedParticipants,
          remoteUsers: remoteUsers, // ✅ NEW: Direct access to remote user objects
          role: role,
          isCreator: isCreator,
          sessionData: updatedSession,
        });

        console.log(`📤 Emitted session_joined to ${username}`);

        // Notify OTHER participants in the room that new user joined
        // ✅ FIX 4: Include full remote user object
        socket.to(roomName).emit('user_joined_session', {
          userId,
          username,
          user: {
            userId,
            username,
            camera: false,
            mic: false,
            screenShare: false,
          },
          participants: updatedParticipants,
          participantCount: updatedParticipants.length,
          totalParticipants: 2,
        });

        console.log(`📢 Broadcasting user_joined_session to room ${roomName}`);
        console.log(`✅ ${username} successfully joined session ${sessionId} with role: ${role}`);
        console.log(`━━━ [join_session] END ━━━\n`);
      } catch (error) {
        console.error('❌ [join_session] Error:', error);
        socket.emit('error', { message: 'Failed to join session: ' + error.message });
      }
    });

    // ─── ASSIGN ROLE (Owner Action) ────────────────────────────────────

    /**
     * Owner assigns roles to participants
     * Only owner can execute this
     */
    socket.on('assign_role', async (data) => {
      try {
        const { targetUserId, role } = data;
        const { sessionId, userId, isCreator } = socket.data;

        if (!isCreator) {
          socket.emit('error', { message: 'Only session owner can assign roles' });
          return;
        }

        if (!Object.values(BUDDY_ROLES).includes(role)) {
          socket.emit('error', { message: 'Invalid role' });
          return;
        }

        // Update role in database
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          [`participants_${targetUserId}.role`]: role,
        });

        // Notify all participants
        buddyNamespace.to(`buddy_${sessionId}`).emit('role_assigned', {
          targetUserId,
          role,
          assignedBy: userId,
        });

        console.log(`[assign_role] ${userId} assigned ${role} to ${targetUserId}`);
      } catch (error) {
        console.error('[assign_role] Error:', error);
        socket.emit('error', { message: 'Failed to assign role: ' + error.message });
      }
    });

    // ─── MEDIA CONTROLS (Camera, Mic) ────────────────────────────────

    /**
     * Toggle camera on/off
     */
    socket.on('toggle_camera', async (data) => {
      try {
        const { userId, sessionId, enabled } = data;
        const { sessionId: sockSessionId, userId: sockUserId } = socket.data;

        if (sessionId !== sockSessionId || userId !== sockUserId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Update in database
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          [`participants_${userId}.camera`]: enabled,
        });

        // Broadcast to all participants
        buddyNamespace.to(`buddy_${sessionId}`).emit('camera_toggled', {
          userId,
          enabled,
        });

        console.log(`[toggle_camera] ${userId} camera: ${enabled}`);
      } catch (error) {
        console.error('[toggle_camera] Error:', error);
        socket.emit('error', { message: 'Failed to toggle camera' });
      }
    });

    /**
     * Toggle microphone on/off
     */
    socket.on('toggle_mic', async (data) => {
      try {
        const { userId, sessionId, enabled } = data;
        const { sessionId: sockSessionId, userId: sockUserId } = socket.data;

        if (sessionId !== sockSessionId || userId !== sockUserId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Update in database
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          [`participants_${userId}.mic`]: enabled,
        });

        // Broadcast to all participants
        buddyNamespace.to(`buddy_${sessionId}`).emit('mic_toggled', {
          userId,
          enabled,
        });

        console.log(`[toggle_mic] ${userId} mic: ${enabled}`);
      } catch (error) {
        console.error('[toggle_mic] Error:', error);
        socket.emit('error', { message: 'Failed to toggle mic' });
      }
    });

    // ─── SCREEN SHARING ────────────────────────────────────────────────

    /**
     * Start screen sharing
     */
    socket.on('start_screenshare', async (data) => {
      try {
        const { userId, sessionId } = data;
        const { sessionId: sockSessionId, userId: sockUserId } = socket.data;

        if (sessionId !== sockSessionId || userId !== sockUserId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Update in database
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          [`participants_${userId}.screenShare`]: true,
          [`participants_${userId}.screenStartTime`]: new Date(),
        });

        // Broadcast to peers via WebRTC signal
        buddyNamespace.to(`buddy_${sessionId}`).emit('screenshare_started', {
          userId,
          startTime: new Date().toISOString(),
        });

        console.log(`[start_screenshare] ${userId} started sharing screen`);
      } catch (error) {
        console.error('[start_screenshare] Error:', error);
        socket.emit('error', { message: 'Failed to start screen share' });
      }
    });

    /**
     * Stop screen sharing
     */
    socket.on('stop_screenshare', async (data) => {
      try {
        const { userId, sessionId } = data;
        const { sessionId: sockSessionId, userId: sockUserId } = socket.data;

        if (sessionId !== sockSessionId || userId !== sockUserId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Update in database
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          [`participants_${userId}.screenShare`]: false,
        });

        // Broadcast to peers
        buddyNamespace.to(`buddy_${sessionId}`).emit('screenshare_stopped', {
          userId,
        });

        console.log(`[stop_screenshare] ${userId} stopped sharing screen`);
      } catch (error) {
        console.error('[stop_screenshare] Error:', error);
        socket.emit('error', { message: 'Failed to stop screen share' });
      }
    });

    // ─── WEBRTC SIGNALING ──────────────────────────────────────────────

    /**
     * Relay WebRTC offer
     */
    socket.on('webrtc_offer', (data) => {
      try {
        const { targetUserId, offer } = data;
        const { sessionId, userId, username } = socket.data;

        // Relay to target user via socket
        buddyNamespace.to(`buddy_${sessionId}`).emit('webrtc_offer_received', {
          from: userId,
          fromName: username,
          offer,
        });

        console.log(`[webrtc_offer] ${userId} -> ${targetUserId}`);
      } catch (error) {
        console.error('[webrtc_offer] Error:', error);
      }
    });

    /**
     * Relay WebRTC answer
     */
    socket.on('webrtc_answer', (data) => {
      try {
        const { targetUserId, answer } = data;
        const { sessionId, userId, username } = socket.data;

        // Relay to other participant
        buddyNamespace.to(`buddy_${sessionId}`).emit('webrtc_answer_received', {
          from: userId,
          fromName: username,
          answer,
        });

        console.log(`[webrtc_answer] ${userId} -> ${targetUserId}`);
      } catch (error) {
        console.error('[webrtc_answer] Error:', error);
      }
    });

    /**
     * Relay ICE candidates
     */
    socket.on('ice_candidate', (data) => {
      try {
        const { targetUserId, candidate } = data;
        const { sessionId, userId } = socket.data;

        // Relay to other participant
        buddyNamespace.to(`buddy_${sessionId}`).emit('ice_candidate_received', {
          from: userId,
          candidate,
        });
      } catch (error) {
        console.error('[ice_candidate] Error:', error);
      }
    });

    // ─── SESSION NOTES ─────────────────────────────────────────────────

    /**
     * Update shared notes during session
     */
    socket.on('update_notes', async (data) => {
      try {
        const { sessionId, content, timestamp } = data;
        const { sessionId: sockSessionId } = socket.data;

        if (sessionId !== sockSessionId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Store note in database
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          sharedNotes: content,
          lastNoteUpdate: new Date(),
        });

        // Broadcast to peers (real-time collaborative editing)
        buddyNamespace.to(`buddy_${sessionId}`).emit('notes_updated', {
          content,
          timestamp,
          updatedBy: socket.data.userId,
        });
      } catch (error) {
        console.error('[update_notes] Error:', error);
        socket.emit('error', { message: 'Failed to update notes' });
      }
    });

    // ─── SESSION COMPLETION ────────────────────────────────────────────

    /**
     * End session and save feedback
     */
    socket.on('end_session', async (data) => {
      try {
        const { sessionId, feedback } = data;
        const { sessionId: sockSessionId, userId } = socket.data;

        if (sessionId !== sockSessionId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Update session status
        await db.collection('interview_buddy_sessions').doc(sessionId).update({
          status: BUDDY_SESSION_STATUS.COMPLETED,
          endedAt: new Date(),
          [`participants_${userId}.feedback`]: feedback,
        });

        // Notify all participants
        buddyNamespace.to(`buddy_${sessionId}`).emit('session_ended', {
          endedBy: userId,
          reason: 'completed',
        });

        console.log(`[end_session] Session ${sessionId} completed`);
      } catch (error) {
        console.error('[end_session] Error:', error);
        socket.emit('error', { message: 'Failed to end session' });
      }
    });

    // ─── DISCONNECT ────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
      try {
        const { sessionId, userId, username } = socket.data;

        if (sessionId && userId) {
          // Update session - mark user as disconnected
          await db.collection('interview_buddy_sessions').doc(sessionId).update({
            [`participants_${userId}.disconnectedAt`]: new Date(),
          });

          // Notify other participants
          buddyNamespace.to(`buddy_${sessionId}`).emit('user_disconnected', {
            userId,
            username,
          });

          console.log(`[disconnect] ${username} disconnected from session ${sessionId}`);
        }
      } catch (error) {
        console.error('[disconnect] Error:', error);
      }
    });
  });

  return buddyNamespace;
}

module.exports = { initializeHumanBuddyHandlers, BUDDY_SESSION_STATUS, BUDDY_ROLES };
