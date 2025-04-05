#!/bin/bash

echo "Running custom startup script..."

# Update package list and install ffmpeg (which includes ffprobe)
echo "Updating package list and installing ffmpeg..."
apt-get update
apt-get install -y ffmpeg --no-install-recommends
echo "ffmpeg installation attempt finished."

# Run the original startup command using exec
echo "Starting Uvicorn server..."
exec uvicorn app:app --host 0.0.0.0 --port 8000
