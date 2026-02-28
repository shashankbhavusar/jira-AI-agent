import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import OpenAI from "openai";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------------------------
   TOOL DEFINITIONS
---------------------------- */

const tools = [
  {
    type: "function",
    function: {
      name: "generate_user_story",
      description: "Generate a structured Jira user story from plain language input",
      parameters: {
        type: "object",
        properties: {
          projectKey: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
          acceptanceCriteria: {
            type: "array",
            items: { type: "string" },
          },
          storyPoints: { type: "number" },
          priority: { type: "string" },
          labels: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["projectKey", "summary", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_jira_issue",
      description: "Create a Jira issue after user confirmation",
      parameters: {
        type: "object",
        properties: {
          projectKey: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
        },
        required: ["projectKey", "summary", "description"],
      },
    },
  },
];

/* ---------------------------
   JIRA FUNCTION
---------------------------- */

async function createJiraIssue({ projectKey, summary, description }) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue`;

  const auth = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString("base64");

  const response = await axios.post(
    url,
    {
      fields: {
        project: { key: projectKey },
        summary,
        description,
        issuetype: { name: "Story" },
      },
    },
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

/* ---------------------------
   AGENT ENDPOINT
---------------------------- */

app.post("/agent", async (req, res) => {
  try {
    const { message } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert Scrum Master. Decide whether to generate a user story or create a Jira issue based on user intent.",
        },
        { role: "user", content: message },
      ],
      tools,
      tool_choice: "auto",
    });

    const responseMessage = completion.choices[0].message;

    /* ---------------------------
       IF TOOL IS CALLED
    ---------------------------- */

    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      // Tool 1: Generate Story
      if (functionName === "generate_user_story") {
        return res.json({
          type: "story_preview",
          story: args,
          message: "Story generated. Confirm to create in Jira.",
        });
      }

      // Tool 2: Create Jira Issue
      if (functionName === "create_jira_issue") {
        const jiraResult = await createJiraIssue(args);

        return res.json({
          type: "jira_created",
          jira: jiraResult,
        });
      }
    }

    // If no tool call
    res.json({ reply: responseMessage.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

export default app;