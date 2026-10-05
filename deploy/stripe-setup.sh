#!/usr/bin/env bash
# Creates what FriendsShare needs in the Stripe account of the STRIPE_SECRET_KEY in
# /srv/friendsshare/.env: the Pro product with a monthly and a yearly price, the webhook endpoint
# and its own customer portal settings. Writes the resulting ids, the webhook signing secret and
# the prices to show into that .env, then restarts the app. Safe to run again: existing objects
# are kept. Runs on the server, so the secrets never leave it:
#
#   ssh <host> 'bash -s' < deploy/stripe-setup.sh
#   ssh <host> 'MONTHLY=199 YEARLY=1188 CURRENCY=eur bash -s' < deploy/stripe-setup.sh
#   ssh <host> 'COPY_KEY_FROM=/srv/other/.env bash -s' < deploy/stripe-setup.sh   # reuse another app's key
#
# The Stripe account may be shared with other products: everything created here is marked
# app=friendsshare, and the server only reacts to events about its own prices.
# Test and live mode are separate accounts in Stripe: switch the key in .env, clear
# STRIPE_WEBHOOK_SECRET and STRIPE_PORTAL_CONFIG, and run this again to go live.
set -euo pipefail

MONTHLY="${MONTHLY:-199}"   # smallest currency unit
YEARLY="${YEARLY:-1188}"
CURRENCY="${CURRENCY:-eur}"
# Software as a service (SaaS) - electronic download - personal use. An eligible tax code is what
# lets Stripe act as merchant of record (Managed Payments) should that be switched on.
TAX_CODE="${TAX_CODE:-txcd_10103100}"

cd /srv/friendsshare
umask 077
setenv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }

if ! grep -q '^STRIPE_SECRET_KEY=.' .env && [ -n "${COPY_KEY_FROM:-}" ]; then
  line=$(grep '^STRIPE_SECRET_KEY=.' "$COPY_KEY_FROM")
  printf '\n# Stripe (https://dashboard.stripe.com/apikeys)\n%s\n' "$line" >> .env
fi
KEY=$(grep '^STRIPE_SECRET_KEY=' .env | cut -d= -f2- || true)
BASE=$(grep '^BASE_URL=' .env | cut -d= -f2- || true)
[ -n "$KEY" ] && [ -n "$BASE" ] || { echo 'Set STRIPE_SECRET_KEY and BASE_URL in /srv/friendsshare/.env first.' >&2; exit 1; }
S=https://api.stripe.com/v1
api() { curl -sS -u "$KEY:" "$@"; }
get() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
ok() { python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit('Stripe: '+d['error'].get('message','error')) if 'error' in d else print(json.dumps(d))"; }

lookup() { api -G "$S/prices" -d "lookup_keys[]=friendsshare_pro_monthly" -d "lookup_keys[]=friendsshare_pro_yearly"; }
if [ "$(lookup | get "len(d.get('data', []))")" = 0 ]; then
  prod=$(api "$S/products" -d name="FriendsShare Pro" -d tax_code="$TAX_CODE" -d "metadata[app]=friendsshare" \
    -d description="Unlimited folders in FriendsShare: share and receive as many folders as you like, of any size." | ok | get "d['id']")
  api "$S/prices" -d product="$prod" -d currency="$CURRENCY" -d unit_amount="$MONTHLY" -d "recurring[interval]=month" -d lookup_key=friendsshare_pro_monthly -d nickname="Pro monthly" -d "metadata[app]=friendsshare" | ok >/dev/null
  api "$S/prices" -d product="$prod" -d currency="$CURRENCY" -d unit_amount="$YEARLY" -d "recurring[interval]=year" -d lookup_key=friendsshare_pro_yearly -d nickname="Pro yearly" -d "metadata[app]=friendsshare" | ok >/dev/null
fi
prices=$(lookup)
pm=$(echo "$prices" | get "[p['id'] for p in d['data'] if p['lookup_key']=='friendsshare_pro_monthly'][0]")
py=$(echo "$prices" | get "[p['id'] for p in d['data'] if p['lookup_key']=='friendsshare_pro_yearly'][0]")
prod=$(echo "$prices" | get "d['data'][0]['product']")

URL="$BASE/api/billing/webhook"
if ! grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' .env; then
  # the signing secret is only shown at creation, so an endpoint without a stored secret is replaced
  for id in $(api "$S/webhook_endpoints?limit=100" | get "' '.join(w['id'] for w in d['data'] if w['url']=='$URL')"); do
    api -X DELETE "$S/webhook_endpoints/$id" >/dev/null
  done
  secret=$(api "$S/webhook_endpoints" -d url="$URL" -d description="FriendsShare plan changes" -d "metadata[app]=friendsshare" \
    -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted" | ok | get "d['secret']")
  setenv STRIPE_WEBHOOK_SECRET "$secret"
fi

# A portal configuration of its own: the account's default one may belong to another product.
if ! grep -q '^STRIPE_PORTAL_CONFIG=bpc_' .env; then
  portal=$(api "$S/billing_portal/configurations" -d "business_profile[headline]=FriendsShare" -d default_return_url="$BASE/account" \
    -d "metadata[app]=friendsshare" \
    -d "features[invoice_history][enabled]=true" -d "features[payment_method_update][enabled]=true" \
    -d "features[customer_update][enabled]=true" -d "features[customer_update][allowed_updates][]=email" \
    -d "features[customer_update][allowed_updates][]=address" -d "features[customer_update][allowed_updates][]=tax_id" \
    -d "features[subscription_cancel][enabled]=true" -d "features[subscription_cancel][mode]=at_period_end" \
    -d "features[subscription_update][enabled]=true" -d "features[subscription_update][default_allowed_updates][]=price" \
    -d "features[subscription_update][proration_behavior]=create_prorations" \
    -d "features[subscription_update][products][0][product]=$prod" \
    -d "features[subscription_update][products][0][prices][]=$pm" -d "features[subscription_update][products][0][prices][]=$py" | ok | get "d['id']")
  setenv STRIPE_PORTAL_CONFIG "$portal"
fi

setenv STRIPE_PRICE_MONTHLY "$pm"
setenv STRIPE_PRICE_YEARLY "$py"
# what people are shown, taken from the real prices so the two cannot drift apart
show() { echo "$prices" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = [p for p in d['data'] if p['lookup_key'] == sys.argv[1]][0]
sym = {'eur': '€', 'usd': '\$', 'gbp': '£'}.get(p['currency'], p['currency'].upper() + ' ')
print('%s%.2f' % (sym, p['unit_amount'] / 100 / int(sys.argv[2])))" "$1" "$2"; }
setenv PRICE_DISPLAY_MONTHLY "$(show friendsshare_pro_monthly 1)"
setenv PRICE_DISPLAY_YEARLY "$(show friendsshare_pro_yearly 1)"
setenv PRICE_DISPLAY_YEARLY_PER_MONTH "$(show friendsshare_pro_yearly 12)"

echo "product  $prod"
echo "$prices" | get "'\n'.join('price    %s  %s  %.2f %s / %s' % (p['id'], p['lookup_key'], p['unit_amount']/100, p['currency'], p['recurring']['interval']) for p in d['data'])"
api "$S/webhook_endpoints?limit=100" | get "'\n'.join('webhook  %s  %s  %s' % (w['id'], w['status'], w['url']) for w in d['data'])"
echo "portal   $(grep '^STRIPE_PORTAL_CONFIG=' .env | cut -d= -f2-)"
echo "shown as $(grep '^PRICE_DISPLAY_MONTHLY=' .env | cut -d= -f2-) a month, or $(grep '^PRICE_DISPLAY_YEARLY=' .env | cut -d= -f2-) a year ($(grep '^PRICE_DISPLAY_YEARLY_PER_MONTH=' .env | cut -d= -f2-) a month)"

if [ -f app/deploy/compose.yml ]; then
  docker compose -f app/deploy/compose.yml --project-directory . up -d --force-recreate >/dev/null 2>&1 && echo 'restarted the app'
fi
