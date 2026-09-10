#!/bin/bash
set -e

cd /home/scott
echo "Removing existing sense directory..."
sudo rm -rf sense/

echo "Cloning latest code from repository..."
git clone https://github.com/stogs/sense.git

cd sense/
echo "Installing dependencies..."
npm install

echo "Starting Homey app..."
homey app run --remote
