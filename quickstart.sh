#!/bin/bash

# OpenProphet Quickstart Script
# Run this to get up and running in minutes

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║          OpenProphet Quickstart                      ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js: $(node --version)${NC}"

# Check Go
if ! command -v go &> /dev/null; then
    echo -e "${RED}✗ Go not found. Install from https://go.dev${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Go: $(go version | awk '{print $3}')${NC}"

# Check OpenCode
if ! command -v opencode &> /dev/null; then
    echo -e "${RED}✗ OpenCode not found. Install from https://opencode.ai${NC}"
    exit 1
fi
echo -e "${GREEN}✓ OpenCode: $(opencode --version 2>&1 | head -1)${NC}"

echo ""
echo -e "${YELLOW}Step 1: Environment Setup${NC}"

# Create .env if missing
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}✓ Created .env from template${NC}"
        echo -e "${YELLOW}  Edit .env and add your API keys!${NC}"
    else
        echo -e "${RED}✗ No .env.example found${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ .env already exists${NC}"
fi

# Check Alpaca keys
source .env 2>/dev/null
if [ -z "$ALPACA_PUBLIC_KEY" ] || [ "$ALPACA_PUBLIC_KEY" = "your_alpaca_public_key" ]; then
    echo -e "${YELLOW}  ⚠ ALPACA_PUBLIC_KEY not set in .env${NC}"
fi

echo ""
echo -e "${YELLOW}Step 2: Authenticate OpenCode${NC}"

if opencode auth list 2>/dev/null | grep -q 'Anthropic'; then
    echo -e "${GREEN}✓ OpenCode authenticated with Anthropic${NC}"
else
    echo -e "${YELLOW}  Run: opencode auth login${NC}"
    echo -e "${YELLOW}  Then add your Anthropic API key${NC}"
fi

echo ""
echo -e "${YELLOW}Step 3: Install Dependencies${NC}"

if [ -f package.json ]; then
    npm install 2>/dev/null || yarn install 2>/dev/null || bun install 2>/dev/null || true
    echo -e "${GREEN}✓ Dependencies ready${NC}"
fi

echo ""
echo -e "${YELLOW}Step 4: Start OpenProphet${NC}"
echo ""

# Start the agent
echo -e "${CYAN}Starting OpenProphet...${NC}"
./start_agent.sh
