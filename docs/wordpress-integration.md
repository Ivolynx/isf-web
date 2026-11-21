# WordPress Headless CMS — ISF Platform Integration Guide

## Overview

The ISF Platform integrates with WordPress as an optional headless CMS for managing the public homepage content. WordPress is used **only** for homepage layout and content editing — all ISF business logic (scholarships, loans, donations, users) remains in the ISF application and PostgreSQL database.

## Architecture

```
WordPress (Headless CMS)                ISF Platform (Main App)
┌─────────────────────────┐             ┌──────────────────────────┐
│ Gutenberg Editor         │             │ Express + Nunjucks         │
│ Homepage Page            │────REST API─▶│ Home Router               │
│ /wp-json/wp/v2/pages     │             │ WordPress Service          │
│ (slug=homepage)          │             │ In-memory cache (60s TTL) │
└─────────────────────────┘             └──────────────────────────┘
         │                                          │
         ▼                                          ▼
   WordPress DB                            PostgreSQL ISF DB
   (MySQL/MariaDB)                         (users, articles, campaigns,
   SEPARATE from ISF DB                    donations, etc.)
```

**Key principles:**
- WordPress DB (MySQL/MariaDB) is completely separate from ISF DB (PostgreSQL)
- WordPress is NOT used for ISF users, articles, campaigns, donations, or financial data
- If WordPress is unavailable, the homepage renders with built-in static content
- No SSO between ISF and WordPress — they have separate authentication

## Local Development Setup

### Option 1: WordPress Studio (Recommended for Mac/Windows)

1. Download **WordPress Studio** from https://developer.wordpress.com/studio/
2. Create a new site
3. Note the local URL (e.g., `http://localhost:8888`)
4. Add to your `.env`:
   ```
   WORDPRESS_BASE_URL=http://localhost:8888
   WORDPRESS_PAGE_SLUG=homepage
   ```

### Option 2: Local.wp

1. Download from https://localwp.com/
2. Create a new WordPress site
3. Note the URL (e.g., `http://isf.local`)
4. Add to `.env`:
   ```
   WORDPRESS_BASE_URL=http://isf.local
   WORDPRESS_PAGE_SLUG=homepage
   ```

### Option 3: Docker Compose

Add to `docker-compose.yml`:
```yaml
wordpress:
  image: wordpress:latest
  ports:
    - "8888:80"
  environment:
    WORDPRESS_DB_HOST: wp-db
    WORDPRESS_DB_USER: wp_user
    WORDPRESS_DB_PASSWORD: wp_password
    WORDPRESS_DB_NAME: wp_db
  depends_on:
    - wp-db

wp-db:
  image: mysql:8.0
  environment:
    MYSQL_ROOT_PASSWORD: root_password
    MYSQL_DATABASE: wp_db
    MYSQL_USER: wp_user
    MYSQL_PASSWORD: wp_password
  volumes:
    - wp_db_data:/var/lib/mysql

volumes:
  wp_db_data:
```

Then set `.env`: `WORDPRESS_BASE_URL=http://localhost:8888`

## WordPress Configuration

### 1. Create the homepage page

1. Log in to WordPress Admin (`/wp-admin`)
2. Go to **Pages → Add New**
3. Set title: "Homepage"
4. Set slug to match `WORDPRESS_PAGE_SLUG` (default: `homepage`)
5. Edit with Gutenberg block editor
6. **Publish** the page

### 2. Configure REST API access

The ISF Platform uses the WordPress REST API (no authentication required for public pages):
- Endpoint: `{WORDPRESS_BASE_URL}/wp-json/wp/v2/pages?slug={WORDPRESS_PAGE_SLUG}`
- No API key needed for published pages

### 3. Verify REST API is working

```bash
curl "http://localhost:8888/wp-json/wp/v2/pages?slug=homepage&_fields=id,slug,title,content"
```

Expected: JSON array with the page content.

## Gutenberg Homepage Editor

### Available blocks for homepage sections

| Section | Recommended Gutenberg Block |
|---------|----------------------------|
| Hero / Cover | Cover block |
| Headline & Description | Heading + Paragraph |
| CTA Buttons | Buttons block |
| Statistics | Columns + Custom HTML |
| Features / Benefits | Columns block |
| Testimonials | Group + Quote |
| FAQ | Details block (or Custom HTML) |
| Footer content | Group + Paragraph |

### Using Full Site Editing (FSE)

For global elements (header, footer), use a **Block Theme** with Full Site Editing:
1. Install a block theme (e.g., Twenty Twenty-Four)
2. Go to **Appearance → Editor**
3. Edit header/footer globally

### Reusable patterns

Create reusable block patterns:
1. Select blocks → Create pattern
2. Patterns appear in the block inserter under **Patterns**

## ISF Dashboard — Homepage Editor Access

When `WORDPRESS_BASE_URL` is configured:
- OWNER and ADMIN roles see an **Edit Beranda ↗** link in the admin sidebar
- The link opens WordPress Admin in a new tab
- WordPress Admin access must be granted separately

### Access control

| Role | ISF Permission | WordPress Access |
|------|---------------|-----------------|
| OWNER | Full ISF access | WordPress Admin (configure manually) |
| ADMIN | Admin ISF access | WordPress Editor (configure manually) |
| EDITOR | CMS only | No WordPress access |
| USER | Portal only | No WordPress access |

**Important:** WordPress credentials are separate from ISF credentials. Do NOT share WordPress Admin access with non-authorised staff.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WORDPRESS_BASE_URL` | WordPress site URL (optional) | not set (disabled) |
| `WORDPRESS_PAGE_SLUG` | Page slug to use as homepage | `homepage` |
| `WORDPRESS_CACHE_TTL` | Cache duration in seconds (0 = disabled) | `60` |

## Fallback Behavior

When WordPress is not configured (`WORDPRESS_BASE_URL` not set):
- ISF renders the built-in static homepage
- No error is shown to visitors
- The "Edit Beranda" link is hidden from admin sidebar

When WordPress is configured but unavailable:
- ISF renders the built-in static homepage (same as above)
- A warning is logged server-side
- No error is shown to visitors
- The cached content (if any) expires after `WORDPRESS_CACHE_TTL` seconds

## Cache Invalidation

The default TTL is 60 seconds. To force immediate refresh:
- Restart the ISF application
- Or implement a WordPress webhook that calls `invalidateWordPressCache()` after publish

## Security Considerations

1. **SSRF prevention**: Only `WORDPRESS_BASE_URL` (explicitly configured) is fetched — no arbitrary URLs
2. **No authentication bypass**: WordPress and ISF use separate auth systems
3. **HTML sanitization**: WordPress content is rendered with `| safe` filter — ensure your WordPress instance is trusted and not accessible to untrusted editors
4. **Private data**: Never store ISF financial data, student records, or user passwords in WordPress
5. **Network isolation**: In production, WordPress can be on a private network with ISF as the only consumer

## Troubleshooting

| Symptom | Cause | Solution |
|---------|-------|----------|
| Homepage still shows static content | WordPress not configured | Set `WORDPRESS_BASE_URL` in `.env` |
| WordPress content not showing | Page not published | Publish the page in WordPress |
| WordPress content not showing | Wrong slug | Check `WORDPRESS_PAGE_SLUG` matches page slug |
| `Edit Beranda` link missing | WordPress not configured | Set `WORDPRESS_BASE_URL` |
| Stale content after edit | Cache TTL | Wait for cache expiry or restart app |
| 500 error on homepage | WordPress throws | Check ISF logs; page falls back to static |
