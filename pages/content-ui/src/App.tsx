import { useEffect, useState } from 'react';
import { Button, useInterval, useVisibilityChange } from '@extension/ui';
import { useStorage, parseOryxUrl } from '@extension/shared';
import { configStorage } from '@extension/storage';
import { request } from '@octokit/request';

enum Progress {
  IDLE,
  RUNNING,
  WAITING,
  FETCHING,
  FETCHED,
  FAILED,
}

enum ArtifactProgress {
  IDLE,
  FETCHING,
  FETCHED,
  FAILED,
}

// from: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#list-workflow-runs-for-a-repository--parameters
enum WorkflowStatus {
  COMPLETED = 'completed',
  ACTION_REQUIRED = 'action_required',
  CANCELLED = 'cancelled',
  FAILURE = 'failure',
  NEUTRAL = 'neutral',
  SKIPPED = 'skipped',
  STALE = 'stale',
  SUCCESS = 'success',
  TIMED_OUT = 'timed_out',
  IN_PROGRESS = 'in_progress',
  QUEUED = 'queued',
  REQUESTED = 'requested',
  WAITING = 'waiting',
  PENDING = 'pending',
}

const WAIT_INTERVAL = 10_000;

let latestWorkflowRun: Date | null = null;

export default function App() {
  const { owner, repo, workflow_id, token, layout_geometry: store_layout_geometry } = useStorage(configStorage);
  // TODO (#1): We need to actually look at the page to figure out correct layout_geometry
  const { layout_geometry: url_layout_geometry, layout_id } = parseOryxUrl();
  const layout_geometry = store_layout_geometry || url_layout_geometry;
  const [progress, setProgress] = useState(Progress.IDLE);
  const [artifactProgress, setArtifactProgress] = useState(ArtifactProgress.IDLE);
  const [latestWorkflow, setLatestWorkflow] = useState<unknown>(null);
  const [artifact, setArtifact] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const optionsUrl = chrome.runtime.getURL('options/index.html');
  const configured = owner && repo && workflow_id && token;
  const visible = useVisibilityChange();

  const headers = {
    authorization: `token ${token}`,
  };
  const inputs = {
    layout_geometry,
    layout_id,
  };
  const ref = 'main';

  // threading? IDK
  const getLatestRunStart = async () => {
    return latestWorkflowRun;
  };

  const runAction = async () => {
    setProgress(Progress.RUNNING);
    latestWorkflowRun = new Date();
    // Wait 1 second to compensate for any clock skew
    await new Promise(r => setTimeout(r, 1_000));
    try {
      const result = await request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
        owner,
        repo,
        workflow_id,
        ref,
        inputs,
        headers,
      });
      console.log('workflow run: ', result);
      setError(null);
      await new Promise(r => setTimeout(r, WAIT_INTERVAL));
      await refresh();
    } catch (error) {
      setProgress(Progress.FAILED);
      setError(error);
    }
  };

  const refresh = async () => {
    if (!visible || !configured || progress == Progress.FETCHING) return;
    setProgress(Progress.FETCHING);
    const workflows = await request('GET /repos/{owner}/{repo}/actions/runs', {
      owner,
      repo,
      headers,
    });
    const newLatestWorkflow = workflows.data?.workflow_runs?.[0];
    const latestWorkflowStart = newLatestWorkflow?.run_started_at ? new Date(newLatestWorkflow.run_started_at) : null;
    const latestRunStart = await getLatestRunStart();
    // Github doesn't return the new workflow for a while, so wait until we get one that started after the button was clicked.
    if (!latestWorkflowStart || !latestRunStart || latestWorkflowStart > latestRunStart) {
      setProgress(Progress.FETCHED);
    } else {
      setProgress(Progress.WAITING);
    }
    console.log('worflow data: ', workflows.data);
    setLatestWorkflow(newLatestWorkflow);
    // No need to get artifact data if workflow hasn't changed or is in progress
    if (
      (newLatestWorkflow.id == latestWorkflow?.id && newLatestWorkflow.status == latestWorkflow?.status) ||
      newLatestWorkflow.status == WorkflowStatus.IN_PROGRESS
    ) {
      return;
    }
    const run_id = newLatestWorkflow.id;
    if (!run_id) {
      setProgress(Progress.FAILED);
      return;
    }
    setArtifactProgress(ArtifactProgress.FETCHING);
    const artifacts = await request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {
      owner,
      repo,
      run_id,
    });
    const artifact_id = artifacts?.data?.artifacts?.[0]?.id;
    if (artifact_id) {
      setArtifact(artifact_id);
      setArtifactProgress(ArtifactProgress.FETCHED);
    } else {
      setArtifactProgress(ArtifactProgress.FAILED);
    }
    console.log('artifact data: ', artifacts);
  };

  useEffect(() => {
    (async () => {
      refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInterval(async () => {
    if (progress !== Progress.RUNNING) {
      await refresh();
    }
  }, WAIT_INTERVAL);

  const downloadLatestArtifact = async () => {
    // TODO: Github API always returns "You must have the actions scope to
    // download artifacts", no matter what scopes are enabled for the PAT.
    //
    // Ideally we'd use the API to get the artifact URL
    // const downloadUrl = await request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
    //   owner,
    //   repo,
    //   artifact_id,
    //   archive_format: 'zip',
    // });

    // but this works I guess
    window.open(`https://github.com/${owner}/${repo}/actions/runs/${latestWorkflow.id}/artifacts/${artifact}`);
  };

  if (!layout_geometry || !layout_id) {
    // not on a layout page
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded bg-transparent px-2 py-1">
      {configured ? (
        progress == Progress.RUNNING ? (
          <div>
            <Button disabled>Running...</Button> Device: {layout_geometry} Layout: {layout_id}
          </div>
        ) : (
          <Button onClick={runAction}>Run Github Workflow</Button>
        )
      ) : (
        <a id="options_link" href={optionsUrl} target="_blank" rel="noreferrer">
          Extension unconfigured, click to open options to configure
        </a>
      )}
      {configured && (
        <div>
          {progress == Progress.FAILED && 'Failed to run workflow'}
          {error?.status == 403 &&
            " Permission error! Make sure you've allowed write for the 'Actions' scope for your access token. "}
          {(progress == Progress.WAITING || progress == Progress.WAITING_LOCAL) &&
            'Waiting for latest workflow to start...'}
          {progress == Progress.FETCHING && 'Getting latest workflow runs...'}
          {progress == Progress.FETCHED &&
            (() => {
              switch (latestWorkflow?.status) {
                case WorkflowStatus.PENDING:
                case WorkflowStatus.REQUESTED:
                case WorkflowStatus.WAITING:
                case WorkflowStatus.QUEUED:
                  return `Latest workflow (started at ${new Date(latestWorkflow.run_started_at).toLocaleString()}) is queued...`;
                case WorkflowStatus.IN_PROGRESS:
                  return `Latest workflow (started at ${new Date(latestWorkflow.run_started_at).toLocaleString()}) is in progress...`;
                case WorkflowStatus.ACTION_REQUIRED:
                case WorkflowStatus.CANCELLED:
                case WorkflowStatus.FAILURE:
                case WorkflowStatus.TIMED_OUT:
                case WorkflowStatus.SKIPPED:
                case WorkflowStatus.STALE:
                case WorkflowStatus.NEUTRAL:
                  return (
                    <div>
                      <a href={latestWorkflow.html_url} target="_blank" rel="noreferrer">
                        Latest workflow (started at {new Date(latestWorkflow.run_started_at).toLocaleString()}) needs
                        attention, click to open Github.
                      </a>
                    </div>
                  );
                case WorkflowStatus.SUCCESS:
                case WorkflowStatus.COMPLETED:
                  return (
                    <div>
                      Latest workflow (started at {new Date(latestWorkflow.run_started_at).toLocaleString()}) is
                      complete:&nbsp;
                      {(() => {
                        switch (artifactProgress) {
                          case ArtifactProgress.IDLE:
                          case ArtifactProgress.FETCHING:
                            return 'Getting artifact for latest workflow...';
                          case ArtifactProgress.FETCHED:
                            return artifact ? (
                              <Button onClick={downloadLatestArtifact}>Download</Button>
                            ) : (
                              <a href={latestWorkflow.html_url} target="_blank" rel="noreferrer">
                                Artifact Missing! Click to open worflow page.
                              </a>
                            );
                          case ArtifactProgress.FAILED:
                            return (
                              <a href={latestWorkflow.html_url} target="_blank" rel="noreferrer">
                                Failed to fetch artifact! Click to open worflow page.
                              </a>
                            );
                        }
                      })()}
                    </div>
                  );
                default:
                  return `Latest workflow has unhandled status ${latestWorkflow?.status}`;
              }
            })()}
        </div>
      )}
    </div>
  );
}
