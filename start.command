#!/bin/bash
# Double-click to start Gobiman and open it in the browser.
cd "$(dirname "$0")"
(sleep 1; open http://localhost:4600) &
node server.js
