import React, { useState, useRef, useEffect } from "react";

function App() {
  const [input, setInput] = useState("");
  const [story, setStory] = useState(null);
  const [jiraResult, setJiraResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [userId] = useState(`user_${Date.now()}`);
  const chatBoxRef = useRef(null);

  // compute Jira domain fallback using Vite's import.meta.env
  const jiraDomain =
    (import.meta && import.meta.env && import.meta.env.VITE_JIRA_DOMAIN)
      ? import.meta.env.VITE_JIRA_DOMAIN
      : window.location.host;

  // Auto-scroll to bottom when messages are added
  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [history, story, jiraResult]);

  const sendMessage = async () => {
    if (!input.trim()) return;

    setLoading(true);
    setHistory(prev => [...prev, { role: "user", content: input }]);

    try {
      const response = await fetch("http://localhost:3000/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ message: input, userId })
      });

      const data = await response.json();
      setLoading(false);

      if (!response.ok || data.error) {
        const errorMsg = data.error || "An error occurred";
        const details = data.details ? ` - ${data.details}` : "";
        setHistory(prev => [...prev, { role: "error", content: `❌ Error: ${errorMsg}${details}` }]);
        return;
      }

      if (data.type === "story_preview") {
        setStory(data.story);
        setJiraResult(null);
        setHistory(prev => [...prev, { role: "assistant", content: data.message }]);
      } else if (data.type === "jira_created") {
        setJiraResult(data.jira);
        setStory(null);
        setHistory(prev => [...prev, { role: "assistant", content: data.message }]);
      } else if (data.reply) {
        setHistory(prev => [...prev, { role: "assistant", content: data.reply }]);
      }
    } catch (err) {
      setLoading(false);
      setHistory(prev => [...prev, { role: "error", content: `❌ Error: ${err.message}` }]);
    }

    setInput("");
  };

  const confirmCreate = async () => {
    if (!story) return;

    setLoading(true);

    try {
      const response = await fetch("http://localhost:3000/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: `Create this story in Jira: ${JSON.stringify(story)}`,
          userId,
          story
        })
      });

      const data = await response.json();
      setLoading(false);

      if (!response.ok || data.error) {
        const errorMsg = data.error || "Failed to create issue";
        const details = data.details ? ` - ${data.details}` : "";
        setHistory(prev => [...prev, { role: "error", content: `❌ Error: ${errorMsg}${details}` }]);
        return;
      }

      if (data.type === "jira_created") {
        setJiraResult(data.jira);
        setStory(null);
        setHistory(prev => [...prev, { role: "assistant", content: `✅ Jira issue created: ${data.jira.key}` }]);
      }
    } catch (err) {
      setLoading(false);
      setHistory(prev => [...prev, { role: "error", content: `❌ Error: ${err.message}` }]);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      sendMessage();
    }
  };

  return (
    <div style={styles.container}>
      <h2>🚀 Jira AI Story Agent</h2>
      <p style={styles.subtitle}>Describe requirements → AI generates story → Confirm → Jira created</p>

      <div style={styles.chatBox} ref={chatBoxRef}>
        {history.length === 0 && (
          <div style={styles.welcomeMessage}>
            <p>👋 Hi! Describe a feature requirement and I'll create a Jira story.</p>
            <p>Example: "Create a login page with email and password fields"</p>
          </div>
        )}

        {history.map((msg, index) => (
          <div
            key={index}
            style={{
              ...styles.message,
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              backgroundColor: 
                msg.role === "user" ? "#007bff" : 
                msg.role === "error" ? "#f8d7da" : 
                "#eee",
              color: 
                msg.role === "user" ? "white" : 
                msg.role === "error" ? "#721c24" : 
                "black",
              border: msg.role === "error" ? "1px solid #f5c6cb" : "none"
            }}
          >
            <pre style={{ whiteSpace: "pre-wrap", wordWrap: "break-word", margin: 0 }}>
              {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
            </pre>
          </div>
        ))}

        {story && (
          <div style={styles.storyCard}>
            <h3>📝 Story Preview</h3>
            <p><strong>Project:</strong> {story.projectKey}</p>
            <p><strong>Summary:</strong> {story.summary}</p>
            <p><strong>Description:</strong></p>
            <p style={styles.descriptionText}>{story.description}</p>

            {story.acceptanceCriteria && story.acceptanceCriteria.length > 0 && (
              <>
                <p><strong>Acceptance Criteria:</strong></p>
                <ul>
                  {story.acceptanceCriteria.map((ac, i) => (
                    <li key={i}>{ac}</li>
                  ))}
                </ul>
              </>
            )}

            {story.storyPoints && (
              <p><strong>Story Points:</strong> {story.storyPoints}</p>
            )}

            {story.priority && (
              <p><strong>Priority:</strong> {story.priority}</p>
            )}

            <button style={styles.confirmBtn} onClick={confirmCreate} disabled={loading}>
              {loading ? "⏳ Creating..." : "✅ Confirm & Create in Jira"}
            </button>
          </div>
        )}

        {jiraResult && (
          <div style={styles.successCard}>
            <h3>🎉 Jira Issue Created!</h3>
            <p><strong>Key:</strong> {jiraResult.key}</p>
            <p><strong>ID:</strong> {jiraResult.id}</p>
            {jiraResult.key && (
              <a
                href={`https://${(jiraDomain || window.location.host)}/browse/${jiraResult.key}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View in Jira →
              </a>
            )}
          </div>
        )}
      </div>

      <div style={styles.inputBox}>
        <input
          type="text"
          placeholder="Describe your feature in simple language..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          style={styles.input}
          disabled={loading}
        />
        <button onClick={sendMessage} style={styles.sendBtn} disabled={loading}>
          {loading ? "⏳" : "Send"}
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: "900px",
    margin: "40px auto",
    fontFamily: "Arial, sans-serif",
    padding: "20px"
  },
  subtitle: {
    fontSize: "14px",
    color: "#666",
    marginBottom: "20px"
  },
  chatBox: {
    display: "flex",
    flexDirection: "column",
    border: "1px solid #ccc",
    padding: "20px",
    borderRadius: "10px",
    minHeight: "400px",
    maxHeight: "600px",
    overflowY: "auto",
    backgroundColor: "#f9f9f9"
  },
  welcomeMessage: {
    padding: "20px",
    backgroundColor: "#e7f3ff",
    borderRadius: "8px",
    textAlign: "center",
    color: "#004085"
  },
  message: {
    padding: "12px 15px",
    borderRadius: "12px",
    margin: "8px 0",
    maxWidth: "70%",
    wordWrap: "break-word"
  },
  storyCard: {
    marginTop: "20px",
    padding: "20px",
    borderRadius: "10px",
    backgroundColor: "#f4f6f8",
    border: "2px solid #007bff"
  },
  descriptionText: {
    whiteSpace: "pre-wrap",
    wordWrap: "break-word"
  },
  successCard: {
    marginTop: "20px",
    padding: "20px",
    borderRadius: "10px",
    backgroundColor: "#d4edda",
    border: "2px solid #28a745"
  },
  inputBox: {
    display: "flex",
    marginTop: "20px",
    gap: "10px"
  },
  input: {
    flex: 1,
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #ddd",
    fontSize: "15px"
  },
  sendBtn: {
    padding: "12px 30px",
    borderRadius: "8px",
    backgroundColor: "#007bff",
    color: "white",
    border: "none",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "15px"
  },
  confirmBtn: {
    marginTop: "15px",
    padding: "10px 20px",
    backgroundColor: "#28a745",
    color: "white",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "15px"
  }
};

export default App;