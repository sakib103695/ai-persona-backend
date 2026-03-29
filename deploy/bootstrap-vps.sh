#!/usr/bin/env bash
# bootstrap-vps.sh
# Run ONCE as root on a fresh Ubuntu 22.04 VPS.
# Installs Docker, Nginx, Certbot, and creates the deploy user.
set -euo pipefail

DEPLOY_USER="deploy"

echo "==================================================="
echo " Persona AI — VPS Bootstrap (Docker edition)"
echo "==================================================="

# ── System packages ───────────────────────────────────────────────────────────
echo ""
echo "==> [1/5] Updating system packages..."
apt-get update -qq
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx ufw

# ── Docker ────────────────────────────────────────────────────────────────────
echo ""
echo "==> [2/5] Installing Docker..."
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# ── Deploy user ───────────────────────────────────────────────────────────────
echo ""
echo "==> [3/5] Creating deploy user..."
id -u $DEPLOY_USER &>/dev/null || useradd -m -s /bin/bash $DEPLOY_USER

# Give deploy user access to Docker (no sudo needed)
usermod -aG docker $DEPLOY_USER

# SSH key setup
mkdir -p /home/$DEPLOY_USER/.ssh
chmod 700 /home/$DEPLOY_USER/.ssh
touch /home/$DEPLOY_USER/.ssh/authorized_keys
chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh

# ── App directory ─────────────────────────────────────────────────────────────
echo ""
echo "==> [4/5] Creating app directory..."
mkdir -p /opt/persona-ai
chown $DEPLOY_USER:$DEPLOY_USER /opt/persona-ai

# ── Nginx ─────────────────────────────────────────────────────────────────────
echo ""
echo "==> [5/5] Configuring Nginx..."
rm -f /etc/nginx/sites-enabled/default

cat > /etc/nginx/sites-available/persona-ai << 'NGINXEOF'
server {
    listen 80 default_server;
    server_name _;
    return 200 'persona-ai: bootstrap ok';
    add_header Content-Type text/plain;
}
NGINXEOF

ln -sf /etc/nginx/sites-available/persona-ai /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
systemctl enable nginx

# ── Firewall ──────────────────────────────────────────────────────────────────
ufw --force enable
ufw allow ssh
ufw allow 'Nginx Full'
ufw status

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "==================================================="
echo " Bootstrap complete!"
echo "==================================================="
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Add your SSH public key:"
echo "   echo 'ssh-ed25519 AAAA...' >> /home/deploy/.ssh/authorized_keys"
echo ""
echo "2. Point your domain DNS A record to this server's IP"
echo ""
echo "3. Get SSL cert:"
echo "   certbot --nginx -d yourdomain.com -d www.yourdomain.com"
echo ""
echo "4. Copy deploy/nginx.conf to /etc/nginx/sites-available/persona-ai"
echo "   (replace yourdomain.com first)"
echo "   nginx -t && systemctl reload nginx"
echo ""
echo "5. Add GitHub Secrets and push to main — CI/CD handles the rest."
echo ""
