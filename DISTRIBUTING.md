# Distributing the preview

Previewers install from the private repo `humanlayer/humanlayer-pi` with their own GitHub login, so each one needs read access. The source stays in `apps/riptide-pi-extension` in `humanlayer/synclayer`; the preview repo is a copy.

## Give someone access

```bash
gh api -X PUT repos/humanlayer/humanlayer-pi/collaborators/<github-user> -f permission=pull
```

GitHub emails them an invite. `pi install` fails until they accept it. Then send them the install steps: https://github.com/humanlayer/humanlayer-pi#install

```bash
gh api repos/humanlayer/humanlayer-pi/collaborators --jq '.[].login'   # who has access
gh api repos/humanlayer/humanlayer-pi/invitations --jq '.[].invitee.login'   # who has not accepted
gh api -X DELETE repos/humanlayer/humanlayer-pi/collaborators/<github-user>   # take access away
```

For a larger group, add a GitHub team to the repo with read access instead.

## Publish a change

Commit the change in synclayer, then from the repo root:

```bash
apps/riptide-pi-extension/scripts/publish-preview.sh --dry-run   # shows what would change
apps/riptide-pi-extension/scripts/publish-preview.sh
```

The script copies the package as committed at HEAD, leaving out uncommitted edits. It swaps the monorepo's `catalog:` versions for real ones, commits `Sync from humanlayer/synclayer@<sha>` and pushes to `main`. Previewers get the change with `pi update --extensions`.

Don't edit the preview repo by hand: the next publish replaces its files.

## Pin a build

Previewers who install without a ref follow `main`. To hold someone on a known build, tag it in the preview repo and have them install `git:git@github.com:humanlayer/humanlayer-pi@<tag>`. pi never moves a pinned ref on update; they reinstall to change it.

## Server support

The server side ships with synclayer deploys: the `pi` coding agent value, and the `attachedSessionsOnly` heartbeat flag that keeps the web app from offering a pi host for launches. A cloud without them still takes pi sessions, but labels them `opencode` and may offer a pi host in the launch pickers, where a launch never starts.
