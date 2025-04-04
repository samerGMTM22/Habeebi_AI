#!/usr/bin/env python
import asyncio
import os
import numpy as np
import sounddevice as sd
from dotenv import load_dotenv

# Import Agent SDK components
from agents import Agent, Runner, WebSearchTool, trace
from agents.voice import (
    VoicePipeline,
    SingleAgentVoiceWorkflow,
    AudioInput,
    VoiceStreamEventAudio,
    VoiceStreamEventLifecycle,
    # VoiceStreamEventError, # Removed as it causes ImportError
    TTSModelSettings,
    STTModelSettings, # Added import
    VoicePipelineConfig
)
from agents.mcp import MCPServerSse

# Load environment variables
load_dotenv()

# --- Global Configuration ---
ZAPIER_MCP_URL = os.getenv("ZAPIER_MCP_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") # Agents SDK might pick this up automatically, but good practice
SAMPLE_RATE = 24000 # Standard for OpenAI TTS

# --- Global Agent and Server Variables ---
# --- Global Agent and Server Variables ---
zapier_server = None
habeebi_agent = None

# --- Cleanup Function ---
async def cleanup_zapier():
    """Cleans up Zapier connection."""
    global zapier_server
    if zapier_server:
        print("Cleaning up Zapier MCP server connection...")
        try:
            await zapier_server.cleanup()
            print("Zapier MCP Cleanup Complete.")
            zapier_server = None # Ensure server object is cleared
        except Exception as e:
            print(f"Error cleaning up Zapier server: {e}")

# --- Refresh Function ---
async def refresh_zapier_and_agent():
    """Cleans up existing connection and re-initializes Agent and Zapier."""
    global zapier_server, habeebi_agent

    print("--- Refreshing Zapier Connection and Agent ---")
    # 1. Cleanup existing connection first
    await cleanup_zapier()

    # 2. Re-initialize Zapier connection
    if ZAPIER_MCP_URL:
        print(f"Configuring Zapier MCP server...")
        # Create a new server instance for the refresh
        new_zapier_server = MCPServerSse(params={"url": ZAPIER_MCP_URL}, name="ZapierServer")
        print("Connecting to Zapier MCP server...")
        try:
            await new_zapier_server.connect()
            zapier_server = new_zapier_server # Assign to global var only on success
            print("Zapier MCP Server Connected.")
        except Exception as e:
            print(f"Error connecting to Zapier MCP server during refresh: {e}. Proceeding without Zapier.")
            zapier_server = None # Ensure it's None if connection failed
    else:
        zapier_server = None # Ensure it's None if URL is not set

    # 3. Re-initialize Agent with the new server instance
    mcp_servers_list = [zapier_server] if zapier_server else []
    print("Re-initializing Habeebi Agent...")
    habeebi_agent = Agent( # Overwrite the global agent instance
        name="HabeebiVoice",
        instructions=(
            "You are Habeebi, a helpful voice assistant. Use web search for current info. "
            "Use Zapier actions for tasks. Keep responses concise, friendly, and natural-sounding for voice output. "
            "Avoid overly technical jargon."
        ),
        tools=[WebSearchTool()],
        mcp_servers=mcp_servers_list,
        model="gpt-4o-mini" # Or gpt-4o for potentially better voice quality/understanding
    )
    print("Habeebi Voice Agent Initialized/Refreshed.")
    print("---------------------------------------------")


async def voice_assistant_loop():
    """Main loop for the voice assistant CLI."""
    # Agent is assumed to be initialized/refreshed before this loop starts
    if not habeebi_agent:
        print("Error: Habeebi agent not available. Exiting loop.")
        return

    # Query for default input device samplerate
    try:
        device_info = sd.query_devices(kind='input')
        samplerate = int(device_info['default_samplerate'])
        print(f"Using default input device samplerate: {samplerate} Hz")
    except Exception as e:
        print(f"Could not query default samplerate, falling back to {SAMPLE_RATE} Hz. Error: {e}")
        samplerate = SAMPLE_RATE # Fallback

    # Define custom TTS model settings (adjust as desired)
    custom_tts_settings = TTSModelSettings(
        # Use 'alloy' as default, can be changed
        voice="alloy",
        # Example instructions from the article, modify as needed
        instructions=(
            "Personality: upbeat, friendly, helpful guide. "
            "Tone: Friendly, clear, and reassuring. "
            "Tempo: Speak at a moderate pace, include brief pauses before questions."
        )
    )
    # stt_settings = STTModelSettings(sample_rate=samplerate) # Removed - sample rate is likely inferred from AudioInput
    voice_pipeline_config = VoicePipelineConfig(
        tts_settings=custom_tts_settings
        # Removed stt_settings - pipeline should use frame_rate from AudioInput
    )

    while True:
        # Create a new pipeline instance for each interaction
        # This ensures clean state and uses the latest config if changed
        pipeline = VoicePipeline(
            workflow=SingleAgentVoiceWorkflow(agent=habeebi_agent),
            config=voice_pipeline_config
        )

        # Check for input to either provide voice or exit
        cmd = input("Press Enter to speak your query (or type 'esc' to exit): ")
        if cmd.lower() == "esc":
            print("Exiting...")
            break
        print("Listening...")
        recorded_chunks = []

        # Callback function to append audio data
        def audio_callback(indata, frames, time, status):
            if status:
                print(f"Audio Input Status: {status}")
            recorded_chunks.append(indata.copy())

        # Start streaming from microphone until Enter is pressed again
        try:
            with sd.InputStream(samplerate=samplerate, channels=1, dtype='int16', callback=audio_callback):
                input("Recording... Press Enter again to stop and process.\n") # Wait for user to press Enter again
        except Exception as e:
            print(f"\nError during recording: {e}")
            continue # Skip to next loop iteration

        if not recorded_chunks:
            print("No audio recorded.")
            continue

        # Concatenate chunks into single buffer
        recording = np.concatenate(recorded_chunks, axis=0)
        print(f"Recording stopped. Processing {len(recording) / samplerate:.2f} seconds of audio...")

        # Input the buffer and await the result
        audio_input = AudioInput(buffer=recording, frame_rate=samplerate)

        # Use tracing for debugging
        with trace("Habeebi Voice CLI Assistant"):
            try:
                result = await pipeline.run(audio_input=audio_input)

                # Collect the streamed audio response
                response_chunks = []
                print("Assistant is responding...")
                async for event in result.stream():
                    if isinstance(event, VoiceStreamEventAudio) and event.data is not None:
                        response_chunks.append(event.data)
                    elif isinstance(event, VoiceStreamEventLifecycle):
                        print(f"[Lifecycle: {event.event}]")
                    # Removed check for VoiceStreamEventError

                if not response_chunks:
                    print("No audio response generated by the pipeline.")
                    continue

                response_audio = np.concatenate(response_chunks, axis=0)

                # Play response using sounddevice
                sd.play(response_audio, samplerate=SAMPLE_RATE) # Play at the TTS output rate
                sd.wait() # Wait for playback to finish
                print("---")

            except Exception as e:
                print(f"\nAn error occurred during pipeline processing: {e}")
                import traceback
                traceback.print_exc()
                print("---") # Separator even on error

async def main():
    """Initializes components and runs the main loop."""
    # Perform initial refresh/initialization
    await refresh_zapier_and_agent()

    # Run the main interaction loop
    try:
        await voice_assistant_loop()
    finally:
        # Ensure final cleanup happens on exit
        await cleanup_zapier()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nExiting due to KeyboardInterrupt.")
    finally:
        # Ensure sounddevice resources are released if loop exits unexpectedly
        sd.stop()
