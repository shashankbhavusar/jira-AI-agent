import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* =====================================================
   GEMINI SETUP
===================================================== */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite",
  tools: {
    functionDeclarations: [
      {
        name: "generate_user_story",
        description:
          "Generate a structured Jira user story from plain language requirement",
        parameters: {
          type: "OBJECT",
          properties: {
            projectKey: { type: "STRING" },
            summary: { type: "STRING" },
            description: { type: "STRING" },
            acceptanceCriteria: {
              type: "ARRAY",
              items: { type: "STRING" }
            },
            storyPoints: { type: "NUMBER" },
            priority: { type: "STRING" },
            labels: {
              type: "ARRAY",
              items: { type: "STRING" }
            }
          },
          required: ["projectKey", "summary", "description"]
        }
      },
      {
        name: "create_jira_issue",
        description: "Create a Jira issue after user confirmation",
        parameters: {
          type: "OBJECT",
          properties: {
            projectKey: { type: "STRING" },
            summary: { type: "STRING" },
            description: { type: "STRING" }
          },
          required: ["projectKey", "summary", "description"]
        }
      }
    ]
  }
});

/* =====================================================
   CONVERSATION HISTORY (Simple in-memory store)
===================================================== */

const conversations = {}; // userId -> conversation history

/* =====================================================
   JIRA FUNCTION
===================================================== */

async function createJiraIssue({ projectKey, summary, description }) {
  // Validate env
  if (!process.env.JIRA_DOMAIN) throw new Error("JIRA_DOMAIN environment variable is not set");
  if (!process.env.JIRA_EMAIL) throw new Error("JIRA_EMAIL environment variable is not set");
  if (!process.env.JIRA_API_TOKEN) throw new Error("JIRA_API_TOKEN environment variable is not set");

  // Normalize domain and build URL
  let domain = process.env.JIRA_DOMAIN.replace(/^https?:\/\//, "");
  const url = `https://${domain}/rest/api/3/issue`;

  console.log("Creating Jira issue with:", { projectKey, summary });
  console.log("Jira URL:", url);

  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");

  // Convert plain-string description to Atlassian Document Format (ADF)
  let descriptionField = description;
  if (typeof description === "string") {
    descriptionField = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: description }]
        }
      ]
    };
  }

  try {
    // Fetch createmeta to learn allowed issue types for the project
    let availableIssueTypes = null;
    try {
      const metaResp = await axios.get(
        `https://${domain}/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      availableIssueTypes = metaResp.data.projects?.[0]?.issuetypes || null;
      console.log("Available issue types for project:", availableIssueTypes?.map(it => ({ id: it.id, name: it.name })));
    } catch (metaErr) {
      console.warn("Failed to fetch createmeta; will fallback to env/name. Error:", metaErr.response?.data || metaErr.message);
    }

    // Prefer project's 'Story' type if present
    let issueType = null;
    if (availableIssueTypes) {
      const storyType = availableIssueTypes.find(it => it.name && it.name.toLowerCase() === "story")
        || availableIssueTypes.find(it => it.name && it.name.toLowerCase().includes("story"));
      if (storyType) issueType = { id: storyType.id };
    }

    // Fall back to env id
    if (!issueType && process.env.JIRA_ISSUE_TYPE_ID) issueType = { id: process.env.JIRA_ISSUE_TYPE_ID };

    // Final fallback: attempt by name 'Story' (may be invalid)
    if (!issueType) issueType = { name: "Story" };

    const payload = {
      fields: {
        project: { key: projectKey },
        summary,
        description: descriptionField,
        issuetype: issueType
      }
    };

    console.log("Jira payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(url, payload, {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }
    });

    return response.data;
  } catch (error) {
    const jiraErr = error.response?.data;
    console.error("Jira API Error:", jiraErr || error.message);

    // If issuetype invalid, surface allowed types (if we fetched them)
    if (jiraErr && jiraErr.errors && jiraErr.errors.issuetype) {
      const allowed = Array.isArray(availableIssueTypes) ? availableIssueTypes.map(it => it.name).join(", ") : null;
      const allowedMsg = allowed ? ` Allowed types: ${allowed}.` : "";
      throw new Error(`Invalid issuetype for project.${allowedMsg} Jira error: ${JSON.stringify(jiraErr.errors)}`);
    }

    throw new Error(
      jiraErr?.errorMessages?.[0] ||
      (jiraErr?.errors ? JSON.stringify(jiraErr.errors) : null) ||
      error.message ||
      "Failed to create Jira issue"
    );
  }
}

/* =====================================================
   LIST AVAILABLE MODELS
===================================================== */

app.get("/models", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
    );
    
    const modelList = response.data.models.map(model => ({
      name: model.name,
      displayName: model.displayName,
      description: model.description,
      version: model.version,
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
      supportedGenerationMethods: model.supportedGenerationMethods
    }));
    
    res.json({ availableModels: modelList });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to list models",
      details: error.message
    });
  }
});

/* =====================================================
   AGENT ENDPOINT (with conversation history & tool decision-making)
===================================================== */

app.post("/agent", async (req, res) => {
  try {
    console.log("/agent request body:", req.body);
    const { message, userId = "default", story } = req.body;

    // If story data is provided directly, create it immediately
    if (story && story.projectKey && story.summary && story.description) {
      const jiraResult = await createJiraIssue(story);
      return res.json({
        type: "jira_created",
        jira: jiraResult,
        message: `Successfully created Jira issue ${jiraResult.key}`
      });
    }

    // Initialize conversation history for this user
    if (!conversations[userId]) {
      conversations[userId] = [];
    }

    // Add user message to history
    conversations[userId].push({
      role: "user",
      parts: [{ text: message }]
    });

    // Build system prompt
    const systemPrompt = `You are an expert Scrum Master and Jira specialist. 
Your job is to:
1. When a user describes a feature requirement, call the "generate_user_story" tool to create a structured story
2. When a user confirms creation (e.g., "create", "confirm", "yes", "create in Jira"), call the "create_jira_issue" tool to actually create the Jira issue
3. Always extract project key, summary, and description from context

Be proactive in deciding which tool to use based on user intent.`;

    // Include system prompt as first message if not already there
    const contents = [
      {
        role: "user",
        parts: [{ text: systemPrompt }]
      },
      {
        role: "model",
        parts: [{ text: "Understood. I will help you manage Jira user stories using the tools provided." }]
      },
      ...conversations[userId]
    ];

    const result = await model.generateContent({
      contents: contents
    });

    const response = result.response;

    console.log("Agent response:", JSON.stringify(response, null, 2));

    // Extract function call (tool call)
    const functionCall = response.candidates?.[0]?.content?.parts?.find(
      part => part.functionCall
    )?.functionCall;

    if (functionCall) {
      const { name, args } = functionCall;
      let assistantMessage = `Called tool: ${name}`;

      // TOOL 1 → Generate Story
      if (name === "generate_user_story") {
        assistantMessage = `Generated story for: ${args.summary}`;
        conversations[userId].push({
          role: "model",
          parts: [{ text: assistantMessage }]
        });

        return res.json({
          type: "story_preview",
          story: args,
          message: "Story generated. Would you like me to create this in Jira?"
        });
      }

      // TOOL 2 → Create Jira Issue
      if (name === "create_jira_issue") {
        const jiraResult = await createJiraIssue(args);
        assistantMessage = `Created Jira issue: ${jiraResult.key}`;
        conversations[userId].push({
          role: "model",
          parts: [{ text: assistantMessage }]
        });

        return res.json({
          type: "jira_created",
          jira: jiraResult,
          message: `Successfully created Jira issue ${jiraResult.key}`
        });
      }
    }

    // If no function call, just reply normally
    const textReply =
      response.candidates?.[0]?.content?.parts?.[0]?.text || "I'm not sure how to help with that.";

    conversations[userId].push({
      role: "model",
      parts: [{ text: textReply }]
    });

    res.json({ reply: textReply });

  } catch (error) {
    console.error("Agent endpoint error:", error);
    // include response data if available
    const details = error.response?.data || error.message || error.stack;
    const status = error.response?.status || 500;
    res.status(status).json({
      error: "Agent error",
      details
    });
  }
});

/* =====================================================
   RESET CONVERSATION (Optional)
===================================================== */

app.post("/agent/reset", (req, res) => {
  const { userId = "default" } = req.body;
  delete conversations[userId];
  res.json({ message: "Conversation reset" });
});

/* =====================================================
   START SERVER
===================================================== */

export default app;