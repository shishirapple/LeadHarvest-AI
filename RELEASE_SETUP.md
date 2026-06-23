# 🤖 Automated Release Setup for LeadHarvest AI

## Overview
This repository now includes **automated CI/CD pipelines** that automatically create GitHub Releases whenever you update the version in `manifest.json` and push to the main branch.

## How It Works

### Automatic Trigger
When you:
1. Update the `"version"` field in `manifest.json`
2. Commit and push to `main` or `master` branch

The GitHub Action will automatically:
- ✅ Detect the new version number
- ✅ Create a git tag (e.g., `v5.0.0`)
- ✅ Generate release notes from commit history
- ✅ Create a GitHub Release with notes
- ✅ Build a ZIP file of the extension
- ✅ Upload the ZIP as a release asset

## Setup Instructions

### Step 1: Push the Workflow to GitHub
```bash
cd /workspace
git add .github/workflows/auto-release.yml
git commit -m "Add automated release workflow"
git push origin main
```

### Step 2: Verify GitHub Actions Permissions
Go to your GitHub repository:
1. Click **Settings** → **Actions** → **General**
2. Ensure **Workflow permissions** is set to **"Read and write permissions"**
3. Enable **"Allow GitHub Actions to create and approve pull requests"** if needed

### Step 3: Test the Automation
Update your version in `manifest.json`:
```json
{
  "version": "5.0.1"  // Change from 5.0.0 to 5.0.1
}
```

Then commit and push:
```bash
git add manifest.json
git commit -m "Bump version to 5.0.1"
git push origin main
```

Watch the magic happen! Check:
- **Actions tab**: See the workflow running
- **Releases tab**: New release will appear automatically

## Version Bumping Workflow

### For Future Updates:

```bash
# 1. Make your code changes
# Edit files as needed...

# 2. Update version in manifest.json
# Example: change "5.0.0" to "5.0.1"

# 3. Commit everything
git add .
git commit -m "feat: description of your changes

- Feature 1
- Feature 2
- Bug fix 3"

# 4. Push to main
git push origin main

# That's it! GitHub Actions handles the rest!
```

## Release Notes Format

The action automatically generates release notes based on your commit messages:

**Good commit message examples:**
```
feat: add dark mode support
fix: resolve queue pause issue
docs: update README with installation steps
perf: improve scraping speed by 40%
```

These will appear in the release as:
- feat: add dark mode support
- fix: resolve queue pause issue
- docs: update README with installation steps
- perf: improve scraping speed by 40%

## Manual Override

If you need to create a manual release:
1. Go to **Releases** → **Draft a new release**
2. Choose or create a tag
3. Add your notes
4. Publish

## Troubleshooting

### Release didn't trigger?
- Check if you pushed to `main` or `master` branch
- Verify `manifest.json` version was actually changed
- Check **Actions** tab for any errors

### Tag already exists error?
- Delete the existing tag: `git tag -d v5.0.0 && git push origin :refs/tags/v5.0.0`
- Or increment the version number in `manifest.json`

### Permission denied?
- Go to **Settings** → **Actions** → **General**
- Enable **Read and write permissions**

## Files Added

| File | Purpose |
|------|---------|
| `.github/workflows/auto-release.yml` | Main CI/CD workflow |
| `RELEASE_SETUP.md` | This documentation |

## Next Steps

1. ✅ Commit and push the `.github` folder to your repository
2. ✅ Verify Actions permissions in GitHub Settings
3. ✅ Test with a version bump
4. 🎉 Enjoy automated releases!

---

**Need help?** The workflow logs in the Actions tab show detailed information about each step.
