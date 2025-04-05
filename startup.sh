#!/bin/bash

# Update package list and install ffmpeg (which includes ffprobe)
apt-get update
apt-get install -y ffmpeg --no-install-recommends

# Run the original startup command
echo "Starting Uvicorn..."
uvicorn app:app --host 0.0.0.0 --port 8000
