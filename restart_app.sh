#!/bin/bash
set -e

APP_DIR="/home/scott/sense"

if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  echo "Pulling latest code from repository..."
  git pull origin main
else
  echo "Cloning latest code from repository..."
  git clone https://github.com/stogs/sense.git "$APP_DIR"
  cd "$APP_DIR"
fi

echo "Starting Homey app..."
homey app run --remote
