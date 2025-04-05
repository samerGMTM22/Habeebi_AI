#!/bin/bash
# Change to the directory where app code is deployed
cd /home/site/wwwroot

# Activate the virtual environment if it exists (Oryx might create one named 'antenv' or '.venv')
# Adjust the venv name if necessary based on build logs or manifest
VENV_NAME=".venv" # Default name, adjust if Oryx uses 'antenv'
if [ -d "$VENV_NAME/bin" ]; then
  echo "Activating virtual environment: $VENV_NAME"
  source "$VENV_NAME/bin/activate"
elif [ -d "antenv/bin" ]; then
  echo "Activating virtual environment: antenv"
  source "antenv/bin/activate"
else
   echo "Virtual environment not found, proceeding without activation."
fi

# Explicitly add the virtual environment's bin to PATH (redundant if activated, but safe)
export PATH=$PATH:/home/site/wwwroot/$VENV_NAME/bin:/home/site/wwwroot/antenv/bin

# Execute the Uvicorn server process, replacing the shell
echo "Executing Uvicorn..."
exec uvicorn app:app --host 0.0.0.0 --port 8000
