import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FeedbackEntry = {
  timestamp: string;
  conversationHistory: Array<{
    speaker: "user" | "assistant";
    text: string;
  }>;
  feedbackReport: {
    type: "explicit" | "inferred";
    sentiment?: "positive" | "negative" | "neutral";
    reason?: string;
    assistantObservation?: string;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const feedbackFilePath = path.join(repoRoot, "logs", "feedback.jsonl");

export const recordFeedback = async (
  conversationHistory: Array<{ speaker: "user" | "assistant"; text: string }>,
  feedbackReport: FeedbackEntry["feedbackReport"]
): Promise<void> => {
  try {
    const entry: FeedbackEntry = {
      timestamp: new Date().toISOString(),
      conversationHistory,
      feedbackReport
    };

    const jsonLine = JSON.stringify(entry) + "\n";

    // Ensure the logs directory exists
    const logsDir = path.dirname(feedbackFilePath);
    await fs.mkdir(logsDir, { recursive: true });

    await fs.appendFile(feedbackFilePath, jsonLine, "utf8");
  } catch (error) {
    console.error("Failed to record feedback:", error);
    throw error;
  }
};

export const createFeedbackTool = {
  type: "function" as const,
  function: {
    name: "record_user_feedback",
    description:
      "Record user feedback or observations about user experience. Use when user explicitly provides feedback or when you detect user frustration/satisfaction.",
    parameters: {
      type: "object",
      properties: {
        feedbackType: {
          type: "string",
          enum: ["explicit", "inferred"],
          description: "Whether this is explicit user feedback or inferred from user behavior/tone"
        },
        sentiment: {
          type: "string",
          enum: ["positive", "negative", "neutral"],
          description: "The sentiment of the feedback"
        },
        reason: {
          type: "string",
          description: "The reason for the feedback (what went well or what went wrong)"
        },
        assistantObservation: {
          type: "string",
          description: "Your observation about what led to this feedback or user state"
        },
        conversationHistory: {
          type: "array",
          items: {
            type: "object",
            properties: {
              speaker: { type: "string", enum: ["user", "assistant"] },
              text: { type: "string" }
            },
            required: ["speaker", "text"]
          },
          description: "The recent conversation history relevant to this feedback"
        }
      },
      required: ["feedbackType", "conversationHistory"]
    }
  }
};
