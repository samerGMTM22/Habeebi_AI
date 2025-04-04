# === Imports ===
# Standard library imports
import asyncio
import os
import io
import json
# Third-party library imports
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from pydub import AudioSegment
import websockets # Ensure websockets library is available

# OpenAI Agents SDK imports
from agents import Agent, Runner, WebSearchTool, trace
from agents.voice import (
    VoicePipeline,
    SingleAgentVoiceWorkflow,
    AudioInput,
    VoiceStreamEventAudio,
    VoiceStreamEventLifecycle,
    TTSModelSettings,
    VoicePipelineConfig
)
from agents.mcp import MCPServerSse

# === Initialization ===
load_dotenv()

# --- FastAPI App Setup ---
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# --- Global Configuration ---
ZAPIER_MCP_URL = os.getenv("ZAPIER_MCP_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SAMPLE_RATE = 24000

# --- Global State Variables ---
zapier_server = None
habeebi_agent = None
agent_initialized = False
agent_lock = asyncio.Lock()

# === Agent Initialization and Refresh Logic (Async) ===
async def cleanup_zapier():
    """(Async) Cleans up the existing Zapier MCP server connection if it exists."""
    global zapier_server
    if zapier_server:
        print("Cleaning up Zapier MCP server connection (async)...")
        try:
            await zapier_server.cleanup()
            print("Zapier MCP Cleanup Complete (async).")
            zapier_server = None
        except Exception as e:
            print(f"Error cleaning up Zapier server (async): {e}")

async def refresh_zapier_and_agent():
    """(Async) Cleans up existing connection, reconnects to Zapier, and re-initializes the Agent."""
    async with agent_lock:
        global zapier_server, habeebi_agent, agent_initialized
        print("--- Refreshing Zapier Connection and Agent (async) ---")
        await cleanup_zapier()

        # Connect to Zapier MCP Server
        if ZAPIER_MCP_URL:
            print(f"Configuring Zapier MCP server (async)...")
            new_zapier_server = MCPServerSse(params={"url": ZAPIER_MCP_URL}, name="ZapierServer")
            print("Connecting to Zapier MCP server (async)...")
            try:
                await new_zapier_server.connect()
                zapier_server = new_zapier_server
                print("Zapier MCP Server Connected (async).")
            except Exception as e:
                print(f"Error connecting to Zapier MCP server during refresh (async): {e}. Proceeding without Zapier.")
                zapier_server = None
        else:
            zapier_server = None

        # Initialize the Agent
        mcp_servers_list = [zapier_server] if zapier_server else []
        print("Re-initializing Habeebi Agent (async)...")
        try:
            habeebi_agent = Agent(
                name="HabeebiFastAPI",
                instructions=(
                    "You are Habeebi, a helpful voice assistant. Use web search for current info. "
                    "Use Zapier actions for tasks. Keep responses concise, friendly, and natural-sounding for voice output. "
                    "Avoid overly technical jargon."
                ),
                tools=[WebSearchTool()],
                mcp_servers=mcp_servers_list,
                model="gpt-4o-mini"
            )
            agent_initialized = True
            print("Habeebi Voice Agent Initialized/Refreshed (async).")
        except Exception as e:
            habeebi_agent = None
            agent_initialized = False
            print(f"Error initializing agent: {e}")

        print("---------------------------------------------")
        return agent_initialized

# === FastAPI Routes ===
@app.get("/", response_class=HTMLResponse)
async def get_index(request: Request):
    """Serves the main HTML page using Jinja2 templates."""
    return templates.TemplateResponse("index.html", {"request": request})

# === WebSocket Endpoint ===
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Handles WebSocket connections, receives audio/commands, streams responses."""
    await websocket.accept()
    client_id = f"{websocket.client.host}:{websocket.client.port}"
    print(f"WebSocket connection accepted from {client_id}")

    # Initial Agent Check
    global agent_initialized
    if not agent_initialized:
        print("Agent not initialized, performing initial refresh...")
        initialized = await refresh_zapier_and_agent()
        status_msg = {"type": "status", "message": "Agent ready"} if initialized else {"type": "error", "message": "Agent initialization failed"}
        await websocket.send_json(status_msg)
    else:
         await websocket.send_json({"type": "status", "message": "Agent ready"})

    # Main WebSocket Loop
    try:
        while True:
            data = await websocket.receive() # Handles bytes or text

            # Handle Binary Data (Audio)
            if "bytes" in data:
                audio_blob_bytes = data["bytes"]
                selected_voice = "alloy" # TODO: Get from client if needed
                print(f"Received audio bytes ({len(audio_blob_bytes)}) from {client_id}")

                if not agent_initialized or not habeebi_agent:
                    await websocket.send_json({"type": "error", "message": "Agent not ready"})
                    continue

                # Process Received Audio Blob
                try:
                    audio_bytes_io = io.BytesIO(audio_blob_bytes)
                    audio_segment = AudioSegment.from_file(audio_bytes_io)
                    audio_segment = audio_segment.set_channels(1).set_sample_width(2)
                    if audio_segment.frame_rate != SAMPLE_RATE:
                        audio_segment = audio_segment.set_frame_rate(SAMPLE_RATE)
                    pcm_data_bytes_for_input = audio_segment.raw_data
                    recorded_buffer_for_input = np.frombuffer(pcm_data_bytes_for_input, dtype=np.int16)
                    audio_input = AudioInput(buffer=recorded_buffer_for_input, frame_rate=SAMPLE_RATE)
                    print(f"Audio successfully processed for agent input for {client_id}.")
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": f"Failed to process audio: {e}"})
                    continue

                # Initialize Voice Pipeline and Stream Response
                try:
                    tts_settings = TTSModelSettings(voice=selected_voice)
                    pipeline_config = VoicePipelineConfig(tts_settings=tts_settings)
                    pipeline_for_request = VoicePipeline(
                        workflow=SingleAgentVoiceWorkflow(agent=habeebi_agent),
                        config=pipeline_config
                    )
                    print(f"Initialized pipeline for request with voice: {selected_voice} for {client_id}")

                    with trace(f"Habeebi FastAPI Voice Assistant - {client_id}"):
                        result = await pipeline_for_request.run(audio_input=audio_input)
                        print(f"Streaming audio response chunks for {client_id}...")
                        async for event in result.stream():
                            if isinstance(event, VoiceStreamEventAudio) and event.data is not None:
                                await websocket.send_bytes(event.data.tobytes())
                            elif isinstance(event, VoiceStreamEventLifecycle):
                                print(f"[Lifecycle Event for {client_id}: {event.event}]")
                        print(f"Finished streaming audio response for {client_id}.")
                        await websocket.send_json({"type": "audio_stream_end"})
                except Exception as e:
                    print(f"An error occurred during voice pipeline processing for {client_id}: {e}")
                    import traceback; traceback.print_exc()
                    await websocket.send_json({"type": "error", "message": f"Agent processing failed: {e}"})

            # Handle Text Data (Commands)
            elif "text" in data:
                 message_text = data["text"]
                 print(f"Received text message from {client_id}: {message_text}")
                 try:
                     command_data = json.loads(message_text)
                     if command_data.get("command") == "refresh_zapier":
                         await websocket.send_json({"type": "status", "message": "Zapier refresh started..."})
                         initialized = await refresh_zapier_and_agent()
                         status = "success" if initialized else "failed"
                         await websocket.send_json({"type": "zapier_refreshed", "status": status})
                     # Add other command handling here if needed
                     else:
                          print(f"Unknown command received: {command_data.get('command')}")
                 except Exception as e:
                     print(f"Error processing command from {client_id}: {e}")
                     await websocket.send_json({"type": "error", "message": "Failed to process command"})

    except WebSocketDisconnect:
        print(f"WebSocket connection closed for {client_id}")
    except Exception as e:
        print(f"WebSocket Error for {client_id}: {e}")
        try: await websocket.close()
        except RuntimeError: pass

# === Server Execution ===
# Run with: uvicorn app:app --host 0.0.0.0 --port 5001 --reload
