#!/bin/bash

VNC_HOST=${VNC_HOST:-localhost}
VNC_PORT=${VNC_PORT:-5900}
VNC_PASSWORD=${VNC_PASSWORD:-changeme}

# Create noVNC redirect
if [ ! -f /opt/noVNC/index.html ]; then
  cat > /opt/noVNC/index.html << 'EOF'
<!DOCTYPE html>
<html><head>
<meta http-equiv="refresh" content="0;url=vnc.html">
</head><body>
<a href="vnc.html">VNC Desktop</a>
</body></html>
EOF
fi

# Start websockify (noVNC proxy)
websockify --web /opt/noVNC 6080 ${VNC_HOST}:${VNC_PORT} > /dev/null 2>&1 &
echo "[noVNC] Started on port 6080 → ${VNC_HOST}:${VNC_PORT}"

# Start landing page
cd /opt/landing
node server.js &
echo "[Landing] Started on port 8080"

# Wait
wait
