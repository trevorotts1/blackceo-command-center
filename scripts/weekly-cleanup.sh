#!/bin/bash
#
# weekly-cleanup.sh - BlackCEO Automation System
# Purpose: Auto-delete stale antfarm workflow embedding indexes older than 7 days
# Location: ~/projects/mission-control/scripts/weekly-cleanup.sh
#

set -euo pipefail

# Configuration
MEMORY_BASE="${HOME}/.openclaw/memory"
WORKFLOW_DIRS=("bug-fix" "feature-dev" "security-audit")
CLEANUP_LOG="${HOME}/Downloads/openclaw-backups/cleanup-log.txt"
RETENTION_DAYS=7
DRY_RUN=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
    esac
done

# Ensure log directory exists
mkdir -p "$(dirname "$CLEANUP_LOG")"

# Log header
echo "========================================" >> "$CLEANUP_LOG"
echo "Cleanup started: $(date '+%Y-%m-%d %H:%M:%S')" >> "$CLEANUP_LOG"
echo "Mode: $([ "$DRY_RUN" = true ] && echo 'DRY RUN' || echo 'LIVE DELETE')" >> "$CLEANUP_LOG"
echo "========================================" >> "$CLEANUP_LOG"

TOTAL_FILES=0
TOTAL_BYTES_FREED=0

# Function to get file size in bytes
get_file_size() {
    stat -f%z "$1" 2>/dev/null || echo 0
}

# Function to format bytes to human readable
format_bytes() {
    local bytes=$1
    if [ "$bytes" -ge 1073741824 ]; then
        printf "%.2f GB" $(echo "scale=2; $bytes / 1073741824" | bc)
    elif [ "$bytes" -ge 1048576 ]; then
        printf "%.2f MB" $(echo "scale=2; $bytes / 1048576" | bc)
    elif [ "$bytes" -ge 1024 ]; then
        printf "%.2f KB" $(echo "scale=2; $bytes / 1024" | bc)
    else
        echo "$bytes bytes"
    fi
}

# Process each workflow directory
for workflow_dir in "${WORKFLOW_DIRS[@]}"; do
    full_path="${MEMORY_BASE}/${workflow_dir}"
    
    if [ ! -d "$full_path" ]; then
        echo "Directory not found: $full_path" >> "$CLEANUP_LOG"
        continue
    fi
    
    echo "" >> "$CLEANUP_LOG"
    echo "Checking: $workflow_dir/" >> "$CLEANUP_LOG"
    
    # Find and process stale .sqlite files
    while IFS= read -r -d '' file; do
        mtime=$(stat -f%m "$file" 2>/dev/null)
        now=$(date +%s)
        age_days=$(( (now - mtime) / 86400 ))
        
        if [ "$age_days" -gt "$RETENTION_DAYS" ]; then
            file_size=$(get_file_size "$file")
            filename=$(basename "$file")
            
            if [ "$DRY_RUN" = true ]; then
                echo "[DRY RUN] Would delete: $filename (${age_days} days old, $(format_bytes $file_size))" | tee -a "$CLEANUP_LOG"
            else
                rm -f "$file"
                echo "Deleted: $filename (${age_days} days old, $(format_bytes $file_size))" >> "$CLEANUP_LOG"
            fi
            
            TOTAL_FILES=$((TOTAL_FILES + 1))
            TOTAL_BYTES_FREED=$((TOTAL_BYTES_FREED + file_size))
        fi
    done < <(find "$full_path" -name "*.sqlite" -type f -print0 2>/dev/null)
    
    # Clean up *.tmp-* files (temp files like verifier.sqlite.tmp-uuid)
    while IFS= read -r -d '' file; do
        file_size=$(get_file_size "$file")
        filename=$(basename "$file")
        
        if [ "$DRY_RUN" = true ]; then
            echo "[DRY RUN] Would delete temp: $filename ($(format_bytes $file_size))" | tee -a "$CLEANUP_LOG"
        else
            rm -f "$file"
            echo "Deleted temp: $filename ($(format_bytes $file_size))" >> "$CLEANUP_LOG"
        fi
        
        TOTAL_FILES=$((TOTAL_FILES + 1))
        TOTAL_BYTES_FREED=$((TOTAL_BYTES_FREED + file_size))
    done < <(find "$full_path" -name "*.tmp-*" -type f -print0 2>/dev/null)
    
    # Clean up journal files
    while IFS= read -r -d '' file; do
        file_size=$(get_file_size "$file")
        filename=$(basename "$file")
        
        if [ "$DRY_RUN" = true ]; then
            echo "[DRY RUN] Would delete journal: $filename ($(format_bytes $file_size))" | tee -a "$CLEANUP_LOG"
        else
            rm -f "$file"
            echo "Deleted journal: $filename ($(format_bytes $file_size))" >> "$CLEANUP_LOG"
        fi
        
        TOTAL_FILES=$((TOTAL_FILES + 1))
        TOTAL_BYTES_FREED=$((TOTAL_BYTES_FREED + file_size))
    done < <(find "$full_path" -name "*.sqlite-journal" -type f -print0 2>/dev/null)
done

# Summary
echo "" >> "$CLEANUP_LOG"
echo "========================================" >> "$CLEANUP_LOG"
echo "Summary: $TOTAL_FILES files processed" >> "$CLEANUP_LOG"
echo "Space freed: $(format_bytes $TOTAL_BYTES_FREED)" >> "$CLEANUP_LOG"
echo "Completed: $(date '+%Y-%m-%d %H:%M:%S')" >> "$CLEANUP_LOG"
echo "========================================" >> "$CLEANUP_LOG"
echo "" >> "$CLEANUP_LOG"

# Console output
echo ""
echo "=== Weekly Cleanup Complete ==="
echo "Files processed: $TOTAL_FILES"
echo "Space that would be freed: $(format_bytes $TOTAL_BYTES_FREED)"
echo "Log saved to: $CLEANUP_LOG"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo "This was a DRY RUN. No files were actually deleted."
    echo "Run without --dry-run to perform actual cleanup."
fi
