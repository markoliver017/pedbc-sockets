// Import required modules
const express = require("express"); // Express.js framework for HTTP server
const { createServer } = require("http"); // HTTP server creation utility
const { Server } = require("socket.io"); // Socket.IO server class
const cors = require("cors"); // Cross-Origin Resource Sharing middleware
require("dotenv").config(); // Load environment variables from .env file

// Initialize Express application
const app = express();
// Create HTTP server instance using Express app
const httpServer = createServer(app);

// Initialize Socket.IO server with HTTP server and configuration
const io = new Server(httpServer, {
  cors: {
    origin: process.env.APP_URL, // Allow Next.js dev server (adjust for production)
    methods: ["GET", "POST"], // Allowed HTTP methods
    credentials: true, // Allow credentials (cookies, authorization headers)
  },
  // Connection timeout settings
  pingTimeout: 60000, // Time to wait for pong response before disconnecting
  pingInterval: 25000, // Interval between ping packets
});

// Enable CORS for Express routes (for REST API endpoints if needed)
app.use(
  cors({
    origin: process.env.APP_URL,
    credentials: true,
  })
);

// Middleware to parse JSON requests
app.use(express.json());

// Store connected users/sessions (in production, use Redis or database)
const connectedUsers = new Map(); // Map to store user sessions
const userSessions = new Map();
const socketToUser = new Map();
const userRooms = new Map(); // Map to track which rooms users are in

// Socket.IO connection handler - runs when a client connects
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`); // Log new connection
  console.log("User sessions on connect:", userSessions);
  console.log("User rooms on connect:", userRooms);
  console.log("Socket to User map on connect:", socketToUser);

  // Handle user authentication/identification
  socket.on("authenticate", (userData) => {
    if (!userData || !userData.userId) return; // Basic validation
    const userId = userData.userId;
    const userRole = userData?.role || null;

    socketToUser.set(socket.id, userId);

    // Initialize or update user sessions
    if (!userSessions.has(userId)) {
      userSessions.set(userId, {
        userData,
        connectedAt: new Date(),
      });
    }

    // Initialize user rooms if first connection
    if (!userRooms.has(userId)) {
      userRooms.set(userId, new Set([`user_${userId}`]));
    }
    // if (userRole && !userRooms.has(userRole)) {
    //   userRooms.set(userRole, new Set([`role_${userRole}`]));
    // }else{

    // }

    console.log(`User authenticated: ${userData.name} (${socket.id})`);

    // Join user's notification room
    socket.join(`user_${userId}`);
    if (userRole) socket.join(userRole);

    // Emit authentication success back to client
    socket.emit("authenticated", {
      status: "success",
      socketId: socket.id,
    });

    // Get an array of all the Set objects from userSessions
    const activeUsers = Array.from(userSessions.values()); //or [...userSessions.values()]
    io.emit("connected_users", activeUsers);
  });

  // Handle client disconnection
  socket.on("disconnect", (reason) => {
    const userId = socketToUser.get(socket.id);

    if (userId) {
      userSessions.delete(userId);
      userRooms.delete(userId);
      socketToUser.delete(socket.id);
    }
    const activeUsers = Array.from(userSessions.values()); //or [...userSessions.values()]
    io.emit("connected_users", activeUsers);

    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
  });

  // Handle joining specific rooms (e.g., project channels, chat rooms)
  socket.on("join_room", (roomName) => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;

    socket.join(roomName);
    userRooms.get(userId).add(roomName);

    // Notify room members
    socket.to(roomName).emit("user_joined", {
      user: userSessions.get(userId),
      room: roomName,
      timestamp: new Date(),
    });

    socket.emit("room_joined", { room: roomName, status: "success" });
  });

  // Handle leaving rooms
  socket.on("leave_room", (roomName) => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    socket.leave(roomName); // Remove socket from Socket.IO room
    // userRooms.get(userId).(roomName);

    // Update user's room list
    const currentRooms = userRooms.get(userId) || [];
    const updatedRooms = currentRooms.filter((room) => room !== roomName);
    userRooms.set(userId, updatedRooms);

    console.log(
      `Socket ${socket.id} with userID: ${userId} left room: ${roomName}`
    );

    // Notify other users in the room about user leaving
    socket.to(roomName).emit("user_left", {
      user: userSessions.get(userId),
      room: roomName,
      timestamp: new Date(),
    });
  });

  // Handle real-time notifications
  socket.on("send_notification", (notificationData) => {
    const sender = connectedUsers.get(socket.id);

    // Create notification object with sender info and timestamp
    const notification = {
      id: Date.now(), // Simple ID generation (use UUID in production)
      type: notificationData.type, // 'info', 'warning', 'error', 'success'
      title: notificationData.title,
      message: notificationData.message,
      sender: sender,
      timestamp: new Date(),
      data: notificationData.data || {}, // Additional payload data
    };

    if (notificationData.targetUserId) {
      // Send to specific user's notification room
      io.to(`user_${notificationData.targetUserId}`).emit(
        "notification",
        notification
      );
    } else if (notificationData.targetRoom) {
      // Send to specific room
      io.to(notificationData.targetRoom).emit("notification", notification);
    } else {
      // Broadcast to all connected clients
      io.emit("notification", notification);
    }

    console.log(`Notification sent by ${sender?.name}: ${notification.title}`);
  });

  // Handle real-time data updates (e.g., document changes, status updates)
  socket.on("data_update", (updateData) => {
    const sender = connectedUsers.get(socket.id);

    // Create update object with metadata
    const update = {
      id: Date.now(),
      type: updateData.type, // 'user_status', 'document_change', 'system_update'
      resource: updateData.resource, // What resource was updated
      resourceId: updateData.resourceId, // ID of the updated resource
      changes: updateData.changes, // What changed
      sender: sender,
      timestamp: new Date(),
    };

    if (updateData.targetRoom) {
      // Send update to specific room
      socket.to(updateData.targetRoom).emit("data_updated", update);
    } else {
      // Broadcast to all clients except sender
      socket.broadcast.emit("data_updated", update);
    }

    console.log(`Data update from ${sender?.name}: ${update.type}`);
  });

  // Handle real-time messages/chat
  socket.on("send_message", (messageData) => {
    const sender = connectedUsers.get(socket.id);

    const message = {
      id: Date.now(),
      content: messageData.content,
      room: messageData.room,
      sender: sender,
      timestamp: new Date(),
      type: messageData.type || "text", // 'text', 'image', 'file', etc.
    };

    // Send message to all users in the room
    io.to(messageData.room).emit("new_message", message);

    console.log(`Message in ${messageData.room} from ${sender?.name}`);
  });

  // Handle user typing indicators
  socket.on("typing_start", (data) => {
    const user = connectedUsers.get(socket.id);
    // Broadcast typing status to room (excluding sender)
    socket.to(data.room).emit("user_typing", {
      user: user,
      room: data.room,
      isTyping: true,
    });
  });

  socket.on("typing_stop", (data) => {
    const user = connectedUsers.get(socket.id);
    // Broadcast stop typing status to room (excluding sender)
    socket.to(data.room).emit("user_typing", {
      user: user,
      room: data.room,
      isTyping: false,
    });
  });

  // Handle connection errors
  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);

    // Emit error back to client
    socket.emit("error_occurred", {
      message: "A socket error occurred",
      timestamp: new Date(),
    });
  });
});

// REST API endpoints for webhook integration
// Endpoint to send notifications via HTTP (webhook)
app.post("/api/webhook/notification", (req, res) => {
  const { targetUserId, targetRoom, type, title, message, data } = req.body;

  // Create notification object
  const notification = {
    id: Date.now(),
    type: type || "info",
    title,
    message,
    sender: { name: "System", role: "system" },
    timestamp: new Date(),
    data: data || {},
  };

  try {
    if (targetUserId) {
      // Send to specific user
      io.to(`user_${targetUserId}`).emit("notification", notification);
    } else if (targetRoom) {
      // Send to specific room
      io.to(targetRoom).emit("notification", notification);
    } else {
      // Broadcast to all users
      io.emit("notification", notification);
    }

    res.json({
      success: true,
      message: "Notification sent successfully",
      notificationId: notification.id,
    });
  } catch (error) {
    console.error("Webhook notification error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send notification",
    });
  }
});

// Endpoint to broadcast data updates via HTTP (webhook)
app.post("/api/webhook/data-update", (req, res) => {
  const { targetRoom, type, resource, resourceId, changes } = req.body;

  const update = {
    id: Date.now(),
    type,
    resource,
    resourceId,
    changes,
    sender: { name: "System", role: "system" },
    timestamp: new Date(),
  };

  try {
    if (targetRoom) {
      io.to(targetRoom).emit("data_updated", update);
    } else {
      io.emit("data_updated", update);
    }

    res.json({
      success: true,
      message: "Data update broadcasted successfully",
      updateId: update.id,
    });
  } catch (error) {
    console.error("Webhook data update error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to broadcast update",
    });
  }
});

// Get connected users info (for admin/debugging)
app.get("/api/connected-users", (req, res) => {
  // userSessions.delete("207ac622-41c8-4f4d-948d-419bd6c0a795");
  const users = Array.from(userSessions.values());
  const allRooms = io.sockets.adapter.rooms;

  // Create an object to store the organized room data
  const roomsData = {};

  // Iterate over the rooms Map
  for (const [roomName, socketsInRoom] of allRooms.entries()) {
    // A socket automatically joins a room with its own ID, so we filter those out
    if (!socketsInRoom.has(roomName)) {
      // Convert the Set of socket IDs into an array for easier use
      const socketIds = Array.from(socketsInRoom);
      roomsData[roomName] = socketIds;
    }
  }
  res.json({
    totalConnected: users.length,
    // users,
    userSessions: Object.fromEntries(userSessions),
    // userRooms: Object.fromEntries(userRooms),
    userRooms: [...userRooms.entries()].reduce((obj, [key, value]) => {
      obj[key] = Array.from(value);
      return obj;
    }, {}),
    socketToUser: Object.fromEntries(socketToUser),
    connectedUsers: Object.fromEntries(connectedUsers),
    roomsData,
  });
});

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on ${process.env.APP_URL} on port: ${PORT}`);
  console.log("Ready to accept WebSocket connections...");
});

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
