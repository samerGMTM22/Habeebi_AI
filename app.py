import asyncio
import os
from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify, Response
import numpy as np
# import sounddevice as sd # Not needed for Flask playback
import io
import wave
from pydub import AudioSegment

# Import Agent SDK components
from agents import Agent, Runner, WebSearchTool
from agents.voice import (
    VoicePipeline,
    SingleAgentVoiceWorkflow,
    AudioInput,
    VoiceStreamEventAudio,
    VoiceStreamEventLifecycle,
    # Import config classes
    VoicePipelineConfig,
    TTSModelSettings,
    STTModelSettings # May need this too
)
from agents.mcp import MCPServerSse
# Import provider if needed for config
from agents.voice.models.openai_model_provider import OpenAIVoiceModelProvider


load_dotenv()

# --- Flask App Setup ---
app = Flask(__name__)

# --- Global Agent Configuration ---
ZAPIER_MCP_URL = os.getenv("ZAPIER_MCP_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SAMPLE_RATE = 24000

# --- Agent and Zapier Initialization ---
# Agent and Zapier server can be initialized once globally
zapier_server = None
habeebi_agent = None # Define globally

# Moved pipeline initialization inside the request handler

async def initialize_agent_components():
    """Initializes Agent and Connects to Zapier."""
    global zapier_server, habeebi_agent

    # Initialize Zapier only once
    if ZAPIER_MCP_URL and not zapier_server:
        print(f"Configuring Zapier MCP server...")
        zapier_server = MCPServerSse(params={"url": ZAPIER_MCP_URL}, name="ZapierServer")
        print("Connecting to Zapier MCP server...")
        try:
            await zapier_server.connect()
            print("Zapier MCP Server Connected.")
        except Exception as e:
            print(f"Error connecting to Zapier MCP server: {e}. Proceeding without Zapier.")
            zapier_server = None

    # Initialize Agent only once
    if not habeebi_agent:
        mcp_servers_list = [zapier_server] if zapier_server else []
        habeebi_agent = Agent(
            name="Habeebi",
            instructions=(
                "You are Habeebi, a helpful assistant. Use web search for current info. "
                "Use Zapier actions for tasks. Keep responses concise for voice."
            ),
            tools=[WebSearchTool()],
            mcp_servers=mcp_servers_list,
            model="gpt-4o-mini"
        )
        print("Habeebi Agent Initialized.")

async def cleanup_zapier():
    """Cleans up Zapier connection."""
    if zapier_server:
        print("Cleaning up Zapier MCP server connection...")
        try:
            await zapier_server.cleanup()
            print("Zapier MCP Cleanup Complete.")
        except Exception as e:
            print(f"Error cleaning up Zapier server: {e}")


# --- Flask Routes ---

@app.route('/')
def index():
    """Serves the main HTML page."""
    return render_template('index.html')

@app.route('/process-voice', methods=['POST'])
async def process_voice():
    """Receives audio, processes it using pydub, returns MP3 audio response."""
    if not OPENAI_API_KEY:
        return jsonify({"error": "Server not configured: OPENAI_API_KEY missing"}), 500

    if not habeebi_agent:
        await initialize_agent_components()
        if not habeebi_agent:
             return jsonify({"error": "Agent failed to initialize"}), 500

    audio_blob = request.files.get('audio_data')
    selected_voice = request.form.get('voice', 'alloy')

    if not audio_blob:
        return jsonify({"error": "No audio data received"}), 400

    print(f"Received audio data, processing with voice: {selected_voice}...")

    # --- Process Audio Blob using pydub (Same as before) ---
    try:
        audio_bytes_io = io.BytesIO()
        audio_blob.save(audio_bytes_io)
        audio_bytes_io.seek(0)
        audio_segment = AudioSegment.from_file(audio_bytes_io)
        audio_segment = audio_segment.set_channels(1)
        audio_segment = audio_segment.set_sample_width(2) # 16-bit
        if audio_segment.frame_rate != SAMPLE_RATE:
             print(f"Resampling audio from {audio_segment.frame_rate} Hz to {SAMPLE_RATE} Hz")
             audio_segment = audio_segment.set_frame_rate(SAMPLE_RATE)
        # Don't need pcm_data_bytes or recorded_buffer here if exporting directly
        print(f"Pydub processed audio duration: {len(audio_segment) / 1000.0} seconds")
        # Create AudioInput from the processed segment's raw data for the agent pipeline
        # Important: Need the raw PCM data for the *pipeline input*
        pcm_data_bytes_for_input = audio_segment.raw_data
        recorded_buffer_for_input = np.frombuffer(pcm_data_bytes_for_input, dtype=np.int16)
        audio_input = AudioInput(buffer=recorded_buffer_for_input, frame_rate=SAMPLE_RATE)
        print(f"Audio successfully processed for agent input.")

    except Exception as e:
        if "ffmpeg" in str(e).lower() or "audiosegment" in str(e).lower():
             print(f"*** Error during pydub/ffmpeg processing: {e} ***")
             return jsonify({"error": f"Audio processing library error: {e}"}), 500
        else:
            print(f"Error processing received audio: {e}")
            return jsonify({"error": f"Failed to process audio file: {e}"}), 400
    # --- End Process Audio Blob ---

    # --- Initialize Pipeline for this request and Run ---
    try:
        tts_settings = TTSModelSettings(voice=selected_voice)
        pipeline_config = VoicePipelineConfig(tts_settings=tts_settings)
        pipeline_for_request = VoicePipeline(
            workflow=SingleAgentVoiceWorkflow(agent=habeebi_agent),
            config=pipeline_config
        )
        print(f"Initialized pipeline for request with voice: {pipeline_for_request.config.tts_settings.voice}")

        result = await pipeline_for_request.run(audio_input=audio_input)

        # --- MODIFICATION START: Collect Bytes and Export as MP3 ---
        all_audio_bytes = bytearray()
        print("Collecting audio response bytes...")
        async for event in result.stream():
            if event.type == "voice_stream_event_audio" and event.data is not None:
                all_audio_bytes.extend(event.data.tobytes())
            elif event.type == "voice_stream_event_lifecycle":
                print(f"[Lifecycle Event: {event.event}]")
            elif event.type == "voice_stream_event_error":
                print(f"[Error Event: {event.error}]")

        print(f"Collected {len(all_audio_bytes)} bytes of raw PCM audio data.")

        if not all_audio_bytes:
             print("Warning: No audio data was generated by the pipeline.")
             return Response(b'', mimetype='audio/mpeg') # Send empty MP3

        # Create a pydub segment from the raw PCM data
        response_segment = AudioSegment(
            data=bytes(all_audio_bytes),
            sample_width=2, # 16-bit
            frame_rate=SAMPLE_RATE,
            channels=1
        )

        # Export the segment to MP3 format in memory
        mp3_buffer = io.BytesIO()
        response_segment.export(mp3_buffer, format="mp3", bitrate="192k") # Export as MP3
        mp3_buffer.seek(0)
        final_mp3_bytes = mp3_buffer.read()
        print(f"Converted to MP3 format ({len(final_mp3_bytes)} bytes).")

        # Return collected MP3 bytes in a single Flask response
        print("Sending complete MP3 audio response to frontend.")
        return Response(final_mp3_bytes, mimetype='audio/mpeg') # Use audio/mpeg for MP3
        # --- MODIFICATION END ---

    except Exception as e:
        print(f"An error occurred during voice pipeline processing: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Agent processing failed: {e}"}), 500
    # --- End Initialize and Run Pipeline ---

# --- Main Execution and Cleanup ---
if __name__ == '__main__':
    # Initialize components that need an event loop
    asyncio.run(initialize_agent_components())

    # Register cleanup function for when Flask exits (more reliable than after app.run)
    import atexit
    atexit.register(lambda: asyncio.run(cleanup_zapier()))

    # Start Flask development server
    app.run(debug=True, port=5000)