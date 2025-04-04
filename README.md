# Habeebi Voice Assistant - Web Application

## Overview

This project is a web-based voice assistant named "Habeebi". You can talk to it through your web browser's microphone, and it will talk back to you with an answer or perform actions.

Think of it like having a conversation with a helpful assistant directly on a webpage. It can search the web for current information and potentially interact with other online services (like Zapier) to complete tasks.

## How it Works: The Big Picture

The application has two main parts that work together:

1.  **The Frontend (What you see and interact with):** This is the webpage you open in your browser. It handles capturing your voice, sending it to the backend, receiving the response, and playing the audio back to you.
2.  **The Backend (The "Brain"):** This is a program running on a server (or your computer during development) that receives your voice input, figures out what you want, uses AI to generate a response (including searching the web or using tools like Zapier), converts that response back into audio, and sends it back to the frontend.

These two parts communicate in real-time using a technology called **WebSockets**, which is like having an open phone line between your browser and the backend server.

## Frontend Details (`templates/index.html`, `static/style.css`, `static/script.js`)

*   **`templates/index.html`:** This file defines the structure of the webpage – the title, buttons ("Hold to Speak", "Refresh Zapier"), the voice selection dropdown, the status display area, and the audio visualizer canvas.
*   **`static/style.css`:** This file controls the appearance of the webpage – colors, layout, button styles, etc.
*   **`static/script.js`:** This is the "action" part of the frontend. It does several key things:
    *   **Connects to Backend:** When the page loads, it establishes the WebSocket connection to the backend server (`setupWebSocket` function).
    *   **Handles Buttons:** It listens for clicks on the "Hold to Speak" button (`setupEventListeners`, `startRecording`, `stopRecording`) and the "Refresh Zapier" button (`setupEventListeners`).
    *   **Records Your Voice:** When you hold the "Hold to Speak" button, it uses the browser's built-in `MediaRecorder` API to capture audio from your microphone (`startRecording`).
    *   **Sends Audio:** When you release the button, it takes the recorded audio, packages it up, and sends it over the WebSocket connection to the backend (`mediaRecorder.onstop`, `ws.send`).
    *   **Receives Audio Response:** It listens for audio data coming back from the backend over the WebSocket (`ws.onmessage`). The backend sends the response audio in small chunks.
    *   **Plays Audio Response:** As audio chunks arrive, it uses the browser's Web Audio API (`playAudioQueue`, `ensureAudioContext`) to decode and play them back immediately and smoothly, creating the effect of a continuous stream of speech.
    *   **Handles Commands:** It listens for text-based commands from the backend (like status updates or refresh confirmations) and updates the status display (`handleServerMessage`).
    *   **Refreshes Zapier:** When you click the "Refresh Zapier" button, it sends a specific command message over the WebSocket to the backend (`setupEventListeners`).
    *   **Visualizer:** It uses the Web Audio API (`AnalyserNode`) to draw a simple waveform on the canvas while you are recording (`connectVisualizer`, `drawVisualizer`).

## Backend Details (`app.py`, `requirements.txt`)

*   **`requirements.txt`:** Lists all the external Python libraries needed for the backend to function (like FastAPI, the Agents SDK, audio processing tools, etc.).
*   **`app.py`:** This is the core Python program that acts as the backend server.
    *   **Web Server Setup (FastAPI):** It uses the FastAPI framework to create the web server. FastAPI is modern and efficient, especially good for handling asynchronous tasks like AI processing and WebSockets.
    *   **Serving Frontend:** It serves the `index.html` file when you visit the main URL (`@app.get("/")`) and provides access to the static files (`/static/style.css`, `/static/script.js`) using `StaticFiles`.
    *   **WebSocket Handling (`/ws`):** It defines a specific endpoint (`@app.websocket("/ws")`) where the frontend JavaScript connects using WebSockets. It handles multiple clients connecting simultaneously.
    *   **Agent Initialization:** When the first client connects (or when a refresh is triggered), it initializes the AI agent (`refresh_zapier_and_agent` function). This involves:
        *   Connecting to the Zapier MCP server (if configured via `ZAPIER_MCP_URL` in the `.env` file) using `MCPServerSse`.
        *   Creating the main `Agent` instance (`HabeebiFastAPI`) using the OpenAI Agents SDK.
        *   Giving the agent its instructions (how to behave) and tools (like `WebSearchTool` and the Zapier connection).
    *   **Receiving Audio/Commands:** Inside the WebSocket handler (`websocket_endpoint`), it continuously listens for messages from the connected browser. It checks if the message is binary audio data or a text command (like "refresh_zapier").
    *   **Audio Processing:** When audio data arrives, it uses the `pydub` library to ensure the audio is in the correct format (sample rate, channels) for the AI (`handle_process_audio` section within `websocket_endpoint`).
    *   **Running the Voice Pipeline:** It takes the processed audio and feeds it into the Agents SDK `VoicePipeline`. This pipeline automatically handles:
        *   **Speech-to-Text (STT):** Converting your spoken audio into text.
        *   **Agent Logic:** Running the `HabeebiFastAPI` agent with the transcribed text. The agent uses its instructions, tools (Web Search, Zapier), and the underlying AI model (`gpt-4o-mini`) to figure out a response.
        *   **Text-to-Speech (TTS):** Converting the agent's text response back into audio using a selected voice (e.g., "alloy").
    *   **Streaming Audio Response:** As the TTS generates audio, the backend immediately sends these small audio chunks (as raw bytes) back to the browser over the WebSocket (`await websocket.send_bytes(...)`). It also sends a special message (`{"type": "audio_stream_end"}`) when the entire response is finished.
    *   **Handling Refresh:** When it receives the "refresh_zapier" command, it calls the `refresh_zapier_and_agent` function to update the agent's connection and tools.

## How to Run

1.  **Ensure Dependencies:** Make sure you have Python installed and the required libraries are installed in your virtual environment (using `pip install -r requirements.txt`).
2.  **Environment Variables:** Create a `.env` file in the project root if you haven't already, and add your `OPENAI_API_KEY` and optionally the `ZAPIER_MCP_URL`.
3.  **Start Server:** Open a terminal in the project directory (and activate the virtual environment) and run the command:
    ```bash
    uvicorn app:app --host 0.0.0.0 --port 5001 --reload
    ```
4.  **Access App:** Open your web browser and go to `http://127.0.0.1:5001`.

The application should load, connect, and be ready for voice interaction.
