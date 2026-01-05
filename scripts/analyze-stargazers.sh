#!/bin/bash
# Analyze stargazers - fetch profiles and extract organizations/followers
#
# Usage:
#   ./analyze-stargazers.sh
#
# Output:
#   - stargazers.json (raw data)
#   - stargazers-summary.csv (company, followers, bio)
#
# Note: GitHub API rate limit is 5000/hour for authenticated requests

set -e

REPO="backnotprop/plannotator"
OUTPUT_DIR="$(dirname "$0")/../.stargazers"
mkdir -p "$OUTPUT_DIR"

echo "=== Stargazer Analysis ==="
echo ""

# Step 1: Get all stargazers
echo "Fetching stargazers..."
gh api "repos/$REPO/stargazers" --paginate --jq '.[].login' > "$OUTPUT_DIR/usernames.txt"
TOTAL=$(wc -l < "$OUTPUT_DIR/usernames.txt" | tr -d ' ')
echo "Found $TOTAL stargazers"
echo ""

# Step 2: Fetch profiles (with rate limit awareness)
echo "Fetching profiles (this may take a few minutes)..."
echo "login,followers,company,location,twitter,bio" > "$OUTPUT_DIR/stargazers.csv"

COUNT=0
while read -r username; do
    COUNT=$((COUNT + 1))

    # Progress indicator
    if [ $((COUNT % 50)) -eq 0 ]; then
        echo "  Processed $COUNT / $TOTAL"
    fi

    # Fetch user profile
    profile=$(gh api "users/$username" 2>/dev/null || echo '{}')

    # Extract fields
    followers=$(echo "$profile" | jq -r '.followers // 0')
    company=$(echo "$profile" | jq -r '.company // ""' | tr ',' ';' | tr '\n' ' ')
    location=$(echo "$profile" | jq -r '.location // ""' | tr ',' ';' | tr '\n' ' ')
    twitter=$(echo "$profile" | jq -r '.twitter_username // ""')
    bio=$(echo "$profile" | jq -r '.bio // ""' | tr ',' ';' | tr '\n' ' ' | cut -c1-100)

    echo "$username,$followers,$company,$location,$twitter,$bio" >> "$OUTPUT_DIR/stargazers.csv"

    # Small delay to be nice to the API
    sleep 0.1

done < "$OUTPUT_DIR/usernames.txt"

echo ""
echo "=== Analysis Complete ==="
echo ""

# Step 3: Generate summary
echo "Top 20 by followers:"
sort -t',' -k2 -nr "$OUTPUT_DIR/stargazers.csv" | head -21 | tail -20 | while IFS=',' read -r user followers company location twitter bio; do
    printf "  %-25s %6s followers" "$user" "$followers"
    [ -n "$company" ] && printf "  @ %s" "$company"
    echo ""
done

echo ""
echo "Organizations found:"
cut -d',' -f3 "$OUTPUT_DIR/stargazers.csv" | grep -v "^$" | grep -v "^company$" | sort | uniq -c | sort -rn | head -20

echo ""
echo "Files saved to: $OUTPUT_DIR/"
echo "  - usernames.txt"
echo "  - stargazers.csv"
