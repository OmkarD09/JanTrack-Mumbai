import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { upload, uploadToCloudinary } from "./lib/cloudinary";
import { insertFeedbackSchema, insertIssueSchema, insertReportSchema } from "@shared/schema";
import { emailService } from "./lib/email";
import { randomInt } from "crypto";

import { getChatResponse } from "./lib/gemini";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // AI Chat Route
  app.post("/api/chat", async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }
      const reply = await getChatResponse(message);
      res.json({ reply });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // OTP Endpoint
  app.post("/api/auth/send-otp", async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).send("Username is required");

    const user = await storage.getUserByUsername(username);

    if (!user || (user.role !== 'main_admin' && user.role !== 'sub_admin')) {
      return res.status(403).send("Access denied or user not found");
    }

    let targetEmail = user.email;

    // For sub_admins, send OTP to the main_admin who created them
    if (user.role === 'sub_admin' && user.createdBy) {
      const mainAdmin = await storage.getUser(user.createdBy);
      if (mainAdmin && mainAdmin.email) {
        targetEmail = mainAdmin.email;
        console.log(`Routing OTP for sub-admin ${user.username} to main-admin ${mainAdmin.username} (${targetEmail})`);
      } else {
        console.warn("Main admin not found or has no email, falling back to sub-admin email");
      }
    }

    if (!targetEmail) {
      return res.status(400).send("No email registered for this admin authentication flow");
    }

    const otp = randomInt(100000, 999999).toString();
    await storage.saveOtp(user.username, otp);
    console.log("Generated OTP for " + user.username + ":", otp); // In prod this log creates a security risk but for dev it is useful

    const emailSent = await emailService.sendEmail(
      targetEmail,
      "JanTrack Admin Login OTP",
      `<p>Your OTP for Admin Login is: <strong>${otp}</strong></p>
       <p>Login attempt for: <strong>${user.username}</strong> (${user.role})</p>
       <p>This code expires in 5 minutes.</p>`
    );

    if (emailSent) {
      res.json({ message: "OTP sent successfully" });
    } else {
      console.error("Failed to send OTP email to " + targetEmail);
      // In dev mode, we might still want to allow login if email fails, but better to enforce it.
      // However, client reads console for OTP in dev usually if email not configured.
      res.json({ message: "OTP generated (Check console if email not configured)" });
    }
  });

  // Create Sub-Admin (Main Admin Only)
  app.post("/api/admin/create-sub-admin", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const userRole = (req.user as any).role;

    if (userRole !== 'main_admin') {
      return res.status(403).send("Only Main Admin can create Sub Admins");
    }

    try {
      const { username, password, email } = req.body;
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).send("Username already exists");
      }

      const { scrypt, randomBytes } = await import('crypto');
      const { promisify } = await import('util');
      const scryptAsync = promisify(scrypt);

      const salt = randomBytes(16).toString("hex");
      const buf = (await scryptAsync(password, salt, 64)) as Buffer;
      const hashedPassword = `${buf.toString("hex")}.${salt}`;

      const newAdmin = await storage.createUser({
        username,
        password: hashedPassword,
        email,
        role: 'sub_admin',
        createdBy: (req.user as any).id
      });

      await storage.createActivityLog({
        adminId: (req.user as any).id,
        adminName: (req.user as any).username,
        action: 'CREATE_SUB_ADMIN',
        entityType: 'USER',
        entityId: newAdmin.id,
        details: { username: newAdmin.username, role: newAdmin.role }
      });

      res.status(201).json(newAdmin);
    } catch (error) {
      console.error("Error creating sub-admin:", error);
      res.status(500).send("Failed to create sub-admin");
    }
  });

  // Enroll Face for Sub-Admin (Main Admin Only)
  app.post("/api/admin/enroll-face", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const userRole = (req.user as any).role;

    if (userRole !== 'main_admin') {
      return res.status(403).send("Only Main Admin can enroll faces");
    }

    const { username, descriptor } = req.body;
    if (!username || !descriptor) return res.status(400).send("Username and face descriptor required");

    try {
      await storage.setFaceDescriptor(username, descriptor);
      res.json({ message: "Face enrolled successfully" });
    } catch (error) {
      console.error("Error enrolling face:", error);
      res.status(500).send("Failed to enroll face");
    }
  });

  app.get("/api/admin/sub-admins", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const userRole = (req.user as any).role;

    if (userRole !== 'main_admin') {
      return res.status(403).send("Only Main Admin can view Sub Admins");
    }

    try {
      const subAdmins = await storage.getSubAdmins((req.user as any).id);
      res.json(subAdmins);
    } catch (error) {
      console.error("Error fetching sub-admins:", error);
      res.status(500).send("Failed to fetch sub-admins");
    }
  });

  // Activity Logs
  app.get("/api/admin/activity-logs", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const userRole = (req.user as any).role;

    // Assuming both main_admin and sub_admin can view logs as per requirement
    // "visible to all other subadmins"
    if (userRole !== 'main_admin' && userRole !== 'sub_admin') {
      return res.status(403).send("Access denied");
    }

    try {
      const logs = await storage.getActivityLogs();
      res.json(logs);
    } catch (error) {
      console.error("Error fetching activity logs:", error);
      res.status(500).send("Failed to fetch activity logs");
    }
  });


  // Stats Route
  app.get("/api/stats", async (req, res) => {
    try {
      const candidates = await storage.getCandidates();
      const reports = await storage.getReports();

      const totalCandidates = candidates.length;
      let totalFundsAllocated = 0;
      let totalPromises = 0;

      candidates.forEach((c: any) => {
        if (c.funds && c.funds.allocated) {
          totalFundsAllocated += Number(c.funds.allocated) || 0;
        }
        if (c.promises) {
          totalPromises += c.promises.length;
        }
      });

      // Convert to Crores
      const totalFundsCr = Math.round(totalFundsAllocated / 10000000);

      const verifiedReports = reports.filter((r: any) => r.status === 'resolved' || r.status === 'verified').length;

      res.json({
        totalCandidates,
        totalFunds: totalFundsCr,
        totalPromises,
        verifiedReports
      });
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  // Candidate routes
  app.get("/api/candidates", async (req, res) => {
    try {
      let candidates = await storage.getCandidates();
      const limit = parseInt(req.query.limit as string);
      if (!isNaN(limit) && limit > 0) {
        candidates = candidates.slice(0, limit);
      }
      res.json(candidates);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch candidates" });
    }
  });

  app.get("/api/candidates/:id", async (req, res) => {
    try {
      const candidate = await storage.getCandidate(req.params.id);
      if (!candidate) {
        return res.status(404).json({ message: "Candidate not found" });
      }
      res.json(candidate);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch candidate" });
    }
  });

  app.post("/api/candidates", async (req, res) => {
    try {
      if (!req.body) {
        console.log("POST /api/candidates: Missing body");
        return res.status(400).json({ message: "Missing body" });
      }
      console.log("POST /api/candidates payload:", JSON.stringify(req.body, null, 2));

      const candidate = await storage.createCandidate(req.body);

      if (req.isAuthenticated() && ((req.user as any).role === 'main_admin' || (req.user as any).role === 'sub_admin')) {
        await storage.createActivityLog({
          adminId: (req.user as any).id,
          adminName: (req.user as any).username,
          action: 'CREATE_CANDIDATE',
          entityType: 'CANDIDATE',
          entityId: candidate.id, // Assuming candidate has an 'id' or '_id' field that fits schema
          details: { name: candidate.name, party: candidate.party }
        });
      }

      res.status(201).json(candidate);
    } catch (error: any) {
      console.error("Error in POST /api/candidates:", error);
      res.status(500).json({ message: "Failed to create candidate", error: error.message });
    }
  });

  app.put("/api/candidates/:id", async (req, res) => {
    try {
      const candidate = await storage.updateCandidate(req.params.id, req.body);
      if (!candidate) {
        return res.status(404).json({ message: "Candidate not found" });
      }

      if (req.isAuthenticated() && ((req.user as any).role === 'main_admin' || (req.user as any).role === 'sub_admin')) {
        await storage.createActivityLog({
          adminId: (req.user as any).id,
          adminName: (req.user as any).username,
          action: 'UPDATE_CANDIDATE',
          entityType: 'CANDIDATE',
          entityId: candidate.id,
          details: { name: candidate.name, status: 'updated' }
        });
      }

      res.json(candidate);
    } catch (error) {
      res.status(500).json({ message: "Failed to update candidate" });
    }
  });

  app.delete("/api/candidates/:id", async (req, res) => {
    try {
      if (req.isAuthenticated() && ((req.user as any).role === 'main_admin' || (req.user as any).role === 'sub_admin')) {
        // We might want to fetch candidate name before deleting for better logs, but simple ID is ok for now
        await storage.createActivityLog({
          adminId: (req.user as any).id,
          adminName: (req.user as any).username,
          action: 'DELETE_CANDIDATE',
          entityType: 'CANDIDATE',
          entityId: req.params.id,
          details: {}
        });
      }
      await storage.deleteCandidate(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete candidate" });
    }
  });

  // Feedback routes
  app.post("/api/candidates/:id/feedback", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const feedback = await storage.createFeedback({
        ...req.body,
        candidateId: req.params.id,
        userId: (req.user as any).id,
        username: (req.user as any).username,
        createdAt: new Date()
      });
      res.status(201).json(feedback);
    } catch (error) {
      res.status(500).json({ message: "Failed to create feedback" });
    }
  });

  app.get("/api/candidates/:id/feedback", async (req, res) => {
    try {
      const feedbacks = await storage.getFeedbacksForCandidate(req.params.id);
      res.json(feedbacks);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch feedbacks" });
    }
  });

  // Issue routes
  app.post("/api/issues", upload.single('image'), async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const { title, description, location } = req.body;
      if (!req.file) {
        return res.status(400).json({ message: "Image is required" });
      }

      const imageUrl = await uploadToCloudinary(req.file);

      const issue = await storage.createIssue({
        title,
        description,
        location,
        imageUrl,
        userId: (req.user as any).id,
        status: 'open'
      });
      res.status(201).json(issue);
    } catch (error: any) {
      console.error("Error creating issue:", error);
      res.status(500).json({ message: "Failed to create issue" });
    }
  });

  app.get("/api/issues", async (req, res) => {
    try {
      const issues = await storage.getIssues();
      res.json(issues);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch issues" });
    }
  });

  app.patch("/api/issues/:id/verify", async (req, res) => {
    if (!req.isAuthenticated()) { // Ideally should check for admin role, but basic auth for now
      // In a real app, check req.user.role === 'admin'
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const issue = await storage.verifyIssue(req.params.id);
      if (!issue) return res.status(404).json({ message: "Issue not found" });

      if (req.isAuthenticated() && ((req.user as any).role === 'main_admin' || (req.user as any).role === 'sub_admin')) {
        await storage.createActivityLog({
          adminId: (req.user as any).id,
          adminName: (req.user as any).username,
          action: 'VERIFY_ISSUE',
          entityType: 'ISSUE',
          entityId: issue._id.toString(),
          details: { title: issue.title, status: 'verified' }
        });
      }

      res.json(issue);
    } catch (error) {
      res.status(500).json({ message: "Failed to verify issue" });
    }
  });

  app.delete("/api/issues/:id", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      await storage.deleteIssue(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete issue" });
    }
  });


  // Report routes
  app.post("/api/reports", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const parsed = insertReportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid input", errors: parsed.error });
      }

      const { candidateId, candidateName } = req.body;
      if (!candidateId || !candidateName) {
        return res.status(400).json({ message: "Candidate ID and Name are required" });
      }

      const report = await storage.createReport({
        ...parsed.data,
        candidateId,
        candidateName,
        reporterId: (req.user as any).id,
        reporterName: (req.user as any).username,
        status: 'pending',
        createdAt: new Date()
      });
      res.status(201).json(report);
    } catch (error) {
      console.error("Error creating report:", error);
      res.status(500).json({ message: "Failed to create report" });
    }
  });

  app.get("/api/reports", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    // Ideally verify admin role here
    const userRole = (req.user as any).role;
    if (userRole !== 'main_admin' && userRole !== 'sub_admin') {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const reports = await storage.getReports();
      res.json(reports);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch reports" });
    }
  });

  app.patch("/api/reports/:id/status", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const userRole = (req.user as any).role;
    if (userRole !== 'main_admin' && userRole !== 'sub_admin') {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const { status } = req.body;
      const report = await storage.updateReportStatus(req.params.id, status);
      if (!report) return res.status(404).json({ message: "Report not found" });

      await storage.createActivityLog({
        adminId: (req.user as any).id,
        adminName: (req.user as any).username,
        action: 'UPDATE_REPORT_STATUS',
        entityType: 'REPORT',
        entityId: report._id.toString(),
        details: { status: status, candidateName: report.candidateName }
      });

      res.json(report);
    } catch (error) {
      res.status(500).json({ message: "Failed to update report" });
    }
  });

  // Generic Upload Route
  app.post("/api/upload", upload.single('image'), async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      const imageUrl = await uploadToCloudinary(req.file);
      res.json({ url: imageUrl });
    } catch (error: any) {
      console.error("Error uploading image:", error);
      res.status(500).json({ message: "Failed to upload image" });
    }
  });

  return httpServer;
}
