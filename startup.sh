#!/bin/bash

echo "Running custom startup script to install ffmpeg..."

# Update package list and install ffmpeg (which includes ffprobe)
apt-get update
apt-get install -y ffmpeg --no-install-recommends

echo "ffmpeg installation attempt finished."

# Exit the script. Azure will run the command specified in the portal's Startup Command field next.
exit 0
