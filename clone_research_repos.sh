#!/bin/bash

# Script to clone all research repositories
# This script clones all repositories mentioned in research/README.md

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create research directory if it doesn't exist
mkdir -p research
cd research

print_status "Cloning repositories into $(pwd)"

# Repository list from research/README.md
declare -A REPOS=(
    # Core OpenAI Projects
    ["openai-realtime-console"]="https://github.com/openai/openai-realtime-console.git"
    ["openai-realtime-agents"]="https://github.com/openai/openai-realtime-agents.git"
    ["openai-agents-js"]="https://github.com/openai/openai-agents-js.git"
    
    # WebRTC Implementations
    ["openai-realtime-webrtc"]="https://github.com/mostafa-drz/openai-realtime-webrtc.git"
    ["simple-realtime-console"]="https://github.com/swyxio/simple-realtime-console.git"
    ["realtime-webrtc"]="https://github.com/gbaeke/realtime-webrtc.git"
    ["openai-realtime-console-webrtc"]="https://github.com/thorwebdev/openai-realtime-console-webrtc.git"
    
    # MCP Integration & Tooling
    ["openai-agents-mcp"]="https://github.com/lastmile-ai/openai-agents-mcp.git"
    ["openai-agents-mcp-server"]="https://github.com/lroolle/openai-agents-mcp-server.git"
    ["mcp-agent"]="https://github.com/lastmile-ai/mcp-agent.git"
    
    # Alternative Implementations
    ["openai-realtime-py"]="https://github.com/p-i-/openai-realtime-py.git"
)

# Counter for statistics
TOTAL_REPOS=${#REPOS[@]}
CLONED=0
SKIPPED=0
FAILED=0

print_status "Found $TOTAL_REPOS repositories to clone"

# Clone each repository
for REPO_NAME in "${!REPOS[@]}"; do
    REPO_URL="${REPOS[$REPO_NAME]}"
    
    echo
    print_status "Processing: $REPO_NAME"
    
    # Check if repository already exists
    if [ -d "$REPO_NAME" ]; then
        print_warning "Repository '$REPO_NAME' already exists. Skipping..."
        SKIPPED=$((SKIPPED + 1))
        continue
    fi
    
    # Clone the repository
    print_status "Cloning $REPO_NAME from $REPO_URL..."
    if git clone "$REPO_URL" "$REPO_NAME"; then
        print_success "Successfully cloned $REPO_NAME"
        CLONED=$((CLONED + 1))
    else
        print_error "Failed to clone $REPO_NAME"
        FAILED=$((FAILED + 1))
    fi
done

# Print summary
echo
print_status "=== CLONING SUMMARY ==="
echo "Total repositories: $TOTAL_REPOS"
echo -e "Successfully cloned: ${GREEN}$CLONED${NC}"
echo -e "Skipped (already exist): ${YELLOW}$SKIPPED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [ $FAILED -eq 0 ]; then
    print_success "All repositories cloned successfully!"
else
    print_warning "Some repositories failed to clone. Check the errors above."
fi

echo
print_status "Repositories are available in: $(pwd)"
