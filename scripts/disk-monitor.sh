#!/bin/bash
#
# disk-monitor.sh - BlackCEO Automation System
# Purpose: Check free disk space and alert if below threshold
# Location: ~/projects/mission-control/scripts/disk-monitor.sh
#

set -euo pipefail

# Configuration - Mac's internal drive
DISK="/dev/disk3s1s1"
WARNING_THRESHOLD_GB=50
CRITICAL_THRESHOLD_GB=20

# Get disk info using df
# Using -k to get 1K blocks, then convert to GB
disk_info=$(df -k "$DISK" 2>/dev/null | tail -1)

if [ -z "$disk_info" ]; then
    echo "ERROR: Could not retrieve disk information for $DISK"
    exit 1
fi

# Parse df output
# Format: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on
available_kb=$(echo "$disk_info" | awk '{print $4}')
available_gb=$((available_kb / 1024 / 1024))

capacity_percent=$(echo "$disk_info" | awk '{print $5}' | tr -d '%')
mounted_on=$(echo "$disk_info" | awk '{print $9}')

# Get human-readable total size
total_hr=$(df -h "$DISK" 2>/dev/null | tail -1 | awk '{print $2}')
used_hr=$(df -h "$DISK" 2>/dev/null | tail -1 | awk '{print $3}')
free_hr=$(df -h "$DISK" 2>/dev/null | tail -1 | awk '{print $4}')

# Output status
if [ "$available_gb" -lt "$CRITICAL_THRESHOLD_GB" ]; then
    echo "🚨 CRITICAL DISK SPACE ALERT"
    echo "=============================="
    echo "Disk: $DISK"
    echo "Mount: $mounted_on"
    echo ""
    echo "Total: $total_hr"
    echo "Used: $used_hr (${capacity_percent}% full)"
    echo "Free: $free_hr"
    echo ""
    echo "⚠️  Free space is critically low!"
    echo "   Only ${available_gb}GB remaining (below ${CRITICAL_THRESHOLD_GB}GB threshold)"
    echo ""
    echo "Action required: Run cleanup immediately!"
elif [ "$available_gb" -lt "$WARNING_THRESHOLD_GB" ]; then
    echo "⚠️  DISK SPACE WARNING"
    echo "====================="
    echo "Disk: $DISK"
    echo "Mount: $mounted_on"
    echo ""
    echo "Total: $total_hr"
    echo "Used: $used_hr (${capacity_percent}% full)"
    echo "Free: $free_hr"
    echo ""
    echo "Free space is running low: ${available_gb}GB remaining"
    echo "(Warning threshold: ${WARNING_THRESHOLD_GB}GB)"
    echo ""
    echo "Consider running cleanup soon."
else
    echo "✅ Disk Space OK"
    echo "==============="
    echo "Disk: $DISK"
    echo "Mount: $mounted_on"
    echo ""
    echo "Total: $total_hr"
    echo "Used: $used_hr (${capacity_percent}% full)"
    echo "Free: $free_hr"
    echo ""
    echo "Free space is healthy: ${available_gb}GB available"
fi
