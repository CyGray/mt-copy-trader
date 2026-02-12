# Deployment

This document describes how to update and redeploy the Docker services on the server.

## Prerequisites
- SSH access to the server.
- Docker and docker-compose installed on the server.
- Repository checked out at /opt/bytrader/mt-copy-trader.

## Redeploy steps
1. SSH into the server: 
   - ssh botuser@116.203.224.13
2. Navigate to the repo:
   - /opt/bytrader/mt-copy-trader
3. Pull latest changes:
   - git pull
4. Rebuild and restart services:
   - docker-compose down
   - docker-compose up -d --build
5. Verify services:
   - docker-compose ps

## Notes
- If git pull fails due to local changes, stash them:
  - git stash push -u -m "auto-stash before pull"
  - git pull
- If the web container fails to recreate due to a legacy compose error, remove and recreate it:
  - docker-compose rm -f web
  - docker-compose up -d web
