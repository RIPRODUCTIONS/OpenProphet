#!/bin/bash
# OpenProphet + Trading System Launcher
# Starts all components for the Prophet trading system

set -e

WORKSPACE="/Users/x/WORKSPACE/Active_Projects/openclaw-trader"
VENV="$WORKSPACE/trading-env"

echo "🚀 Starting OpenProphet Trading System..."

# 1. Activate trading environment
echo "📦 Activating trading environment..."
cd "$WORKSPACE"
source "$VENV/bin/activate"

# 2. Check if OpenProphet is running
if ! lsof -ti:3737 > /dev/null 2>&1; then
    echo "🔧 Starting OpenProphet server..."
    cd "$WORKSPACE"
    nohup node agent/server.js > /tmp/openprophet-dash.log 2>&1 &
    sleep 3
    echo "✅ OpenProphet started on port 3737"
else
    echo "✅ OpenProphet already running on port 3737"
fi

# 3. Verify OpenProphet is responding
echo "🔍 Checking OpenProphet health..."
if curl -s http://localhost:3737/health > /dev/null; then
    echo "✅ OpenProphet is healthy"
else
    echo "❌ OpenProphet health check failed"
    exit 1
fi

# 4. Check ML libraries
echo "🧠 Verifying ML libraries..."
MISSING_LIBS=()
for lib in lightgbm catboost xgboost torch scikit-learn; do
    if ! python -c "import $lib" 2>/dev/null; then
        MISSING_LIBS+=($lib)
    fi
done

if [ ${#MISSING_LIBS[@]} -gt 0 ]; then
    echo "📥 Installing missing ML libraries: ${MISSING_LIBS[*]}"
    pip install "${MISSING_LIBS[@]}"
fi
echo "✅ ML libraries verified"

# 5. Display system status
echo ""
echo "📊 System Status Summary:"
echo "========================"
echo "✅ OpenProphet API: http://localhost:3737"
echo "✅ Trading Environment: $VENV" 
echo "✅ ML Libraries: lightgbm, catboost, xgboost, torch, scikit-learn"
echo "✅ Hummingbot Config: hummingbot_workspace/conf/prophet_mm_config.yml"
echo "✅ Trading Script: hummingbot_workspace/scripts/prophet_mm.py"
echo "✅ Dashboard Script: prophet_dashboard.py"
echo ""

# 6. Show next steps
echo "🎯 Next Steps:"
echo "=============="
echo "1. Set up API authentication for OpenProphet"
echo "2. Configure Coinbase Pro API credentials"
echo "3. Start Docker/Colima: colima start"
echo "4. Launch Hummingbot: cd hummingbot_workspace && docker-compose up -d"
echo "5. Run dashboard: python prophet_dashboard.py"
echo ""

# 7. Show current process info
echo "🔧 Running Processes:"
echo "==================="
OPID=$(lsof -ti:3737 2>/dev/null | head -1)
if [ -n "$OPID" ]; then
    echo "OpenProphet (PID $OPID): http://localhost:3737"
fi

echo ""
echo "🚀 OpenProphet Trading System is ready!"
echo "View logs: tail -f /tmp/openprophet-dash.log"
echo "Dashboard URL: http://localhost:3737"