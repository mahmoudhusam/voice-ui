(function () {
  'use strict';

  var MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

  // --- State ---
  var selectedFiles = [];
  var clientId = null;
  var ws = null;
  var activeJobs = {};
  var jobTimers = {};
  var totalJobs = 0;
  var completedCount = 0;
  var failedCount = 0;
  var wsConnected = false;

  // --- DOM refs ---
  var dropZone = document.getElementById('dropZone');
  var fileInput = document.getElementById('fileInput');
  var fileList = document.getElementById('fileList');
  var fileListHeader = document.getElementById('fileListHeader');
  var fileListCount = document.getElementById('fileListCount');
  var clearAllBtn = document.getElementById('clearAllBtn');
  var transcribeBtn = document.getElementById('transcribeBtn');
  var jobsSection = document.getElementById('jobsSection');
  var uploadSection = document.getElementById('uploadSection');
  var optionsSection = document.getElementById('optionsSection');
  var languageSelect = document.getElementById('languageSelect');
  var outputBaseName = document.getElementById('outputBaseName');
  var inlineError = document.getElementById('inlineError');
  var connectionBanner = document.getElementById('connectionBanner');
  var folderInput = document.getElementById('folderInput');
  var folderBrowse = document.getElementById('folderBrowse');
  var outputPath = document.getElementById('outputPath');
  var browseBtn = document.getElementById('browseBtn');

  // --- WebSocket ---
  function connectWebSocket() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.addEventListener('open', function () {
      console.log('[WS] Connected');
      wsConnected = true;
      connectionBanner.classList.remove('visible');
    });

    ws.addEventListener('message', function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      handleWSMessage(msg);
    });

    ws.addEventListener('close', function () {
      console.log('[WS] Disconnected, reconnecting in 3s...');
      wsConnected = false;
      clientId = null;
      connectionBanner.classList.add('visible');
      setTimeout(connectWebSocket, 3000);
    });

    ws.addEventListener('error', function () {
      // close event will fire after this, triggering reconnect
    });
  }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'connected':
        clientId = msg.id;
        console.log('[WS] Client ID:', clientId);
        break;

      case 'job_queued':
        updateJobCard(msg.jobId, {
          status: 'queued',
          statusText: 'Queued (position ' + msg.position + ')',
        });
        break;

      case 'job_started':
        updateJobCard(msg.jobId, {
          status: 'converting',
          statusText: 'Starting...',
          percent: 0,
        });
        break;

      case 'progress':
        if (msg.stage === 'transcribing') {
          clearJobTimer(msg.jobId);
          startJobTimer(msg.jobId);
          updateJobCard(msg.jobId, {
            status: 'transcribing',
            percent: msg.percent,
          });
        } else {
          updateJobCard(msg.jobId, {
            status: msg.stage,
            statusText: 'Converting audio... ' + msg.percent + '%',
            percent: msg.percent,
          });
        }
        break;

      case 'job_completed':
        clearJobTimer(msg.jobId);
        completedCount++;
        updateJobCard(msg.jobId, {
          status: 'completed',
          statusText: 'Completed',
          percent: 100,
          outputs: msg.outputs,
          duration: msg.duration,
          savedToPath: msg.savedToPath || '',
        });
        checkAllDone();
        break;

      case 'job_failed':
        clearJobTimer(msg.jobId);
        failedCount++;
        updateJobCard(msg.jobId, {
          status: 'failed',
          statusText: 'Failed',
          percent: 100,
          error: msg.error,
        });
        checkAllDone();
        break;
    }
  }

  // --- Inline error ---
  function showError(message) {
    inlineError.textContent = message;
  }

  function clearError() {
    inlineError.textContent = '';
  }

  // --- File handling ---
  function addFiles(newFiles) {
    var rejected = [];
    for (var i = 0; i < newFiles.length; i++) {
      if (newFiles[i].size > MAX_FILE_SIZE) {
        rejected.push(newFiles[i].name);
        continue;
      }
      var dup = selectedFiles.some(function (f) {
        return f.name === newFiles[i].name && f.size === newFiles[i].size;
      });
      if (!dup) {
        selectedFiles.push(newFiles[i]);
      }
    }
    if (rejected.length > 0) {
      showError('File too large (max 500 MB): ' + rejected.join(', '));
    } else {
      clearError();
    }
    renderFileList();
    updateTranscribeBtn();
  }

  function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
    updateTranscribeBtn();
    clearError();
  }

  function clearAllFiles() {
    selectedFiles = [];
    renderFileList();
    updateTranscribeBtn();
    clearError();
  }

  function renderFileList() {
    fileList.innerHTML = '';
    if (selectedFiles.length === 0) {
      fileListHeader.style.display = 'none';
      return;
    }
    fileListHeader.style.display = 'flex';
    fileListCount.textContent = selectedFiles.length + ' file' + (selectedFiles.length !== 1 ? 's' : '') + ' selected';

    selectedFiles.forEach(function (file, i) {
      var item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML =
        '<svg class="file-item-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
        '<polyline points="14 2 14 8 20 8"/></svg>' +
        '<div class="file-item-info">' +
        '<div class="file-item-name">' + escapeHtml(file.name) + '</div>' +
        '<div class="file-item-size">' + formatFileSize(file.size) + '</div>' +
        '</div>' +
        '<button class="file-item-remove" data-index="' + i + '" title="Remove">&times;</button>';
      fileList.appendChild(item);
    });
  }

  // --- Drag & Drop ---
  dropZone.addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) {
      addFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  folderBrowse.addEventListener('click', function () {
    folderInput.click();
  });

  var SUPPORTED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.mp3', '.wav', '.m4a', '.ogg', '.flac'];

  folderInput.addEventListener('change', function () {
    if (folderInput.files.length) {
      var filtered = Array.prototype.filter.call(folderInput.files, function (f) {
        var ext = f.name.lastIndexOf('.') !== -1 ? f.name.substring(f.name.lastIndexOf('.')).toLowerCase() : '';
        return SUPPORTED_EXTENSIONS.indexOf(ext) !== -1;
      });
      if (filtered.length > 0) {
        addFiles(filtered);
      } else {
        showError('No supported audio/video files found in the selected folder.');
      }
      folderInput.value = '';
    }
  });

  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  // Remove file via delegation
  fileList.addEventListener('click', function (e) {
    var btn = e.target.closest('.file-item-remove');
    if (btn) {
      var idx = parseInt(btn.getAttribute('data-index'), 10);
      removeFile(idx);
    }
  });

  // Clear all
  clearAllBtn.addEventListener('click', function () {
    clearAllFiles();
  });

  // --- Transcribe ---
  function updateTranscribeBtn() {
    transcribeBtn.disabled = selectedFiles.length === 0;
  }

  transcribeBtn.addEventListener('click', function () {
    clearError();

    if (selectedFiles.length === 0) {
      showError('Please add at least one file to transcribe.');
      return;
    }

    var formats = getSelectedFormats();
    if (formats.length === 0) {
      showError('Please select at least one output format.');
      return;
    }

    if (!clientId) {
      showError('Not connected to the server. Please wait a moment and try again.');
      return;
    }

    startTranscription(formats);
  });

  function getSelectedFormats() {
    var checks = document.querySelectorAll('input[name="format"]:checked');
    var formats = [];
    checks.forEach(function (c) { formats.push(c.value); });
    return formats;
  }

  function startTranscription(formats) {
    var formData = new FormData();

    selectedFiles.forEach(function (file) {
      formData.append('files', file);
    });

    formData.append('language', languageSelect.value);
    formData.append('outputFormats', JSON.stringify(formats));
    formData.append('clientId', clientId);

    var task = document.querySelector('input[name="task"]:checked').value;
    formData.append('task', task);

    var nameVal = outputBaseName.value.trim();
    if (nameVal) {
      formData.append('outputBaseName', nameVal);
    }

    formData.append('outputPath', outputPath.value.trim());

    // UI: disable upload, show processing state
    setProcessingState(true);
    jobsSection.innerHTML = '';
    activeJobs = {};
    totalJobs = selectedFiles.length;
    completedCount = 0;
    failedCount = 0;

    fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) {
          throw new Error(data.error || 'Upload failed');
        }
        data.jobs.forEach(function (job) {
          createJobCard(job.id, job.originalName);
          activeJobs[job.id] = { originalName: job.originalName };
        });
        var firstCard = document.querySelector('.job-card');
        if (firstCard) {
          firstCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      })
      .catch(function (err) {
        showError('Error: ' + err.message);
        setProcessingState(false);
      });
  }

  function setProcessingState(processing) {
    if (processing) {
      uploadSection.classList.add('disabled');
      optionsSection.classList.add('disabled');
      transcribeBtn.disabled = true;
      transcribeBtn.classList.add('processing');
      transcribeBtn.innerHTML = '<span class="spinner"></span>Processing...';
      fileList.style.display = 'none';
      fileListHeader.style.display = 'none';
    } else {
      uploadSection.classList.remove('disabled');
      optionsSection.classList.remove('disabled');
      transcribeBtn.classList.remove('processing');
      transcribeBtn.innerHTML = 'Start Transcription';
      fileList.style.display = '';
      selectedFiles = [];
      renderFileList();
      updateTranscribeBtn();
    }
  }

  // --- Job Cards ---
  function createJobCard(jobId, originalName) {
    var card = document.createElement('div');
    card.className = 'job-card';
    card.id = 'job-' + jobId;
    card.innerHTML =
      '<div class="job-card-header">' +
      '<span class="job-card-name">' + escapeHtml(originalName) + '</span>' +
      '<span class="badge badge-queued" id="badge-' + jobId + '">Queued</span>' +
      '</div>' +
      '<div class="progress-area">' +
      '<div class="progress-bar-track">' +
      '<div class="progress-bar-fill queued" id="bar-' + jobId + '"></div>' +
      '</div>' +
      '<div class="progress-text" id="ptext-' + jobId + '">Waiting...</div>' +
      '</div>' +
      '<div id="downloads-' + jobId + '"></div>';
    jobsSection.appendChild(card);
  }

  function updateJobCard(jobId, data) {
    var badge = document.getElementById('badge-' + jobId);
    var bar = document.getElementById('bar-' + jobId);
    var ptext = document.getElementById('ptext-' + jobId);
    var downloads = document.getElementById('downloads-' + jobId);

    if (!badge) return;

    // Update badge
    badge.className = 'badge badge-' + data.status;
    var badgeLabels = {
      queued: 'Queued',
      converting: 'Converting',
      transcribing: 'Transcribing',
      completed: 'Completed',
      failed: 'Failed',
    };
    badge.textContent = badgeLabels[data.status] || data.status;

    // Update progress bar
    if (data.status === 'queued') {
      bar.className = 'progress-bar-fill queued';
      bar.style.width = '';
    } else if (data.status === 'transcribing') {
      if (data.percent !== undefined && data.percent > 0) {
        bar.className = 'progress-bar-fill';
        bar.style.width = data.percent + '%';
        // Store percent so the elapsed timer can show it
        if (jobTimers[jobId]) {
          jobTimers[jobId].lastPercent = data.percent;
        }
      } else {
        bar.className = 'progress-bar-fill transcribing-pulse';
        bar.style.width = '';
      }
    } else if (data.percent !== undefined) {
      bar.className = 'progress-bar-fill';
      bar.style.width = data.percent + '%';
      if (data.status === 'converting') bar.classList.add('converting');
      else if (data.status === 'completed') bar.classList.add('completed');
      else if (data.status === 'failed') bar.classList.add('failed');
    }

    // Update progress text
    if (data.statusText) {
      ptext.textContent = data.statusText;
    }

    // Show downloads + duration
    if (data.status === 'completed' && data.outputs) {
      var html = '';
      var autoSaved = data.savedToPath && data.savedToPath.length > 0;
      if (autoSaved) {
        html += '<div class="saved-path-msg">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
          'Files saved to: ' + escapeHtml(data.savedToPath) +
          '</div>';
      }
      var btnClass = autoSaved ? 'btn-download-secondary' : 'btn-download';
      var iconSize = autoSaved ? '12' : '14';
      html += '<div class="job-downloads">';
      data.outputs.forEach(function (o) {
        html +=
          '<a class="' + btnClass + '" href="' + o.downloadUrl + '" download>' +
          '<svg viewBox="0 0 24 24" width="' + iconSize + '" height="' + iconSize + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
          '<polyline points="7 10 12 15 17 10"/>' +
          '<line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          o.format.toUpperCase() +
          '</a>';
      });
      // Preview button
      html +=
        '<button class="preview-btn" data-jobid="' + jobId + '">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
        '<circle cx="12" cy="12" r="3"/></svg>' +
        'Preview</button>';
      html += '</div>';
      if (data.duration) {
        html += '<div class="job-duration">' + formatDuration(data.duration) + '</div>';
      }
      html += '<div id="preview-area-' + jobId + '"></div>';
      downloads.innerHTML = html;
    }

    // Show error
    if (data.status === 'failed' && data.error) {
      var errorMsg = friendlyError(data.error);
      downloads.innerHTML = '<div class="job-error">' + escapeHtml(errorMsg) + '</div>';
    }
  }

  function checkAllDone() {
    if (completedCount + failedCount >= totalJobs) {
      transcribeBtn.classList.remove('processing');
      transcribeBtn.innerHTML = 'Start Transcription';

      // Summary
      var summaryHtml = '';
      if (failedCount === 0) {
        summaryHtml = completedCount + ' file' + (completedCount !== 1 ? 's' : '') + ' transcribed successfully';
      } else {
        summaryHtml = completedCount + ' completed, ' + failedCount + ' failed';
      }

      var summaryDiv = document.createElement('div');
      summaryDiv.className = 'job-summary';
      summaryDiv.textContent = summaryHtml;
      jobsSection.appendChild(summaryDiv);

      // Reset button
      var resetDiv = document.createElement('div');
      resetDiv.style.textAlign = 'center';
      resetDiv.innerHTML = '<button class="btn-reset" id="resetBtn">Transcribe more files</button>';
      jobsSection.appendChild(resetDiv);

      document.getElementById('resetBtn').addEventListener('click', function () {
        setProcessingState(false);
        jobsSection.innerHTML = '';
        clearError();
      });
    }
  }

  // --- Job Timers ---
  function startJobTimer(jobId) {
    if (jobTimers[jobId]) {
      clearInterval(jobTimers[jobId].interval);
      delete jobTimers[jobId];
    }
    var startTime = Date.now();
    var ptext = document.getElementById('ptext-' + jobId);
    function updateElapsed() {
      var elapsed = Math.floor((Date.now() - startTime) / 1000);
      var min = Math.floor(elapsed / 60);
      var sec = elapsed % 60;
      var timeStr = min + ':' + (sec < 10 ? '0' : '') + sec;
      var timer = jobTimers[jobId];
      var percentStr = timer && timer.lastPercent > 0 ? timer.lastPercent + '% ' : '';
      if (ptext) ptext.textContent = 'Transcribing... ' + percentStr + '(' + timeStr + ' elapsed)';
    }
    updateElapsed();
    jobTimers[jobId] = {
      startTime: startTime,
      interval: setInterval(updateElapsed, 1000),
      lastPercent: 0,
    };
  }

  function clearJobTimer(jobId) {
    if (jobTimers[jobId]) {
      clearInterval(jobTimers[jobId].interval);
      delete jobTimers[jobId];
    }
  }

  // --- Helpers ---
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatDuration(ms) {
    var totalSec = Math.round(ms / 1000);
    if (totalSec < 60) {
      return 'Completed in ' + totalSec + ' sec';
    }
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;
    return 'Completed in ' + min + ' min ' + sec + ' sec';
  }

  function friendlyError(msg) {
    if (msg.indexOf('whisper-server') !== -1 || msg.indexOf('Whisper server') !== -1) {
      return 'Transcription server is not available. Please restart the application.';
    }
    if (msg.indexOf('Failed to start ffmpeg') !== -1 || msg.indexOf('ENOENT') !== -1 && msg.indexOf('ffmpeg') !== -1) {
      return 'Audio converter (ffmpeg) not found. Please check that ffmpeg is installed.';
    }
    if (msg.indexOf('model') !== -1 && msg.indexOf('not found') !== -1 || msg.indexOf('no such file') !== -1 && msg.indexOf('model') !== -1) {
      return 'Model file not found. Please check your model configuration.';
    }
    return msg;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // --- Preview ---
  jobsSection.addEventListener('click', function (e) {
    var previewBtn = e.target.closest('.preview-btn');
    if (previewBtn) {
      var jid = previewBtn.getAttribute('data-jobid');
      var area = document.getElementById('preview-area-' + jid);
      if (!area) return;
      if (area.innerHTML) {
        area.innerHTML = '';
        return;
      }
      previewBtn.disabled = true;
      fetch('/api/jobs/' + jid + '/preview')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          area.innerHTML =
            '<div class="preview-container">' +
            '<div class="preview-header"><span>Preview</span><button class="preview-close" data-jobid="' + jid + '">&times;</button></div>' +
            '<pre dir="auto" style="margin:0;font-family:inherit;font-size:inherit;white-space:pre-wrap;word-wrap:break-word;">' + escapeHtml(data.text) + '</pre>' +
            '</div>';
          previewBtn.disabled = false;
        })
        .catch(function () {
          area.innerHTML = '<div class="job-error">Failed to load preview.</div>';
          previewBtn.disabled = false;
        });
      return;
    }

    var closeBtn = e.target.closest('.preview-close');
    if (closeBtn) {
      var jid2 = closeBtn.getAttribute('data-jobid');
      var area2 = document.getElementById('preview-area-' + jid2);
      if (area2) area2.innerHTML = '';
    }
  });

  // --- Folder Browser Modal ---
  browseBtn.addEventListener('click', function () {
    openFolderBrowser();
  });

  function openFolderBrowser(startPath) {
    var overlay = document.createElement('div');
    overlay.className = 'folder-modal-overlay';
    overlay.innerHTML =
      '<div class="folder-modal">' +
      '<div class="folder-modal-path" id="folderModalPath">Loading...</div>' +
      '<div class="folder-list" id="folderList"></div>' +
      '<div class="folder-modal-actions">' +
      '<button class="btn-browse" id="folderCancelBtn">Cancel</button>' +
      '<button class="btn-primary" style="padding:9px 20px;font-size:0.9rem" id="folderSelectBtn">Select this folder</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var currentBrowsePath = '';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    document.getElementById('folderCancelBtn').addEventListener('click', function () {
      overlay.remove();
    });

    document.getElementById('folderSelectBtn').addEventListener('click', function () {
      if (currentBrowsePath) {
        outputPath.value = currentBrowsePath;
      }
      overlay.remove();
    });

    function loadFolder(folderPath) {
      var url = '/api/browse-folders';
      if (folderPath) {
        url += '?path=' + encodeURIComponent(folderPath);
      }
      var pathEl = document.getElementById('folderModalPath');
      var listEl = document.getElementById('folderList');
      pathEl.textContent = 'Loading...';
      listEl.innerHTML = '';

      fetch(url)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) {
            pathEl.textContent = 'Error: ' + data.error;
            return;
          }
          currentBrowsePath = data.currentPath;
          pathEl.textContent = data.currentPath;

          var html = '';

          // Parent directory
          if (data.parentPath) {
            html += '<div class="folder-item" data-path="' + escapeHtml(data.parentPath) + '">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
              '..</div>';
          }

          // Drive letters (Windows)
          if (data.drives) {
            data.drives.forEach(function (d) {
              html += '<div class="folder-item" data-path="' + escapeHtml(d) + '">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="12" x2="6" y2="12.01"/></svg>' +
                escapeHtml(d) + '</div>';
            });
          }

          // Folders
          data.folders.forEach(function (name) {
            html += '<div class="folder-item" data-path="' + escapeHtml(data.currentPath + (data.currentPath.endsWith('/') || data.currentPath.endsWith('\\') ? '' : '/') + name) + '">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
              escapeHtml(name) + '</div>';
          });

          if (!data.folders.length && !data.drives) {
            html += '<div style="padding:12px;color:var(--text-muted);font-size:0.85rem;text-align:center;">No subfolders</div>';
          }

          listEl.innerHTML = html;
        })
        .catch(function () {
          pathEl.textContent = 'Failed to load folders';
        });
    }

    // Navigate on folder click
    overlay.querySelector('.folder-modal').addEventListener('click', function (e) {
      var item = e.target.closest('.folder-item');
      if (item) {
        loadFolder(item.getAttribute('data-path'));
      }
    });

    // Start loading
    loadFolder(startPath || outputPath.value.trim() || '');
  }

  // --- Init ---
  connectWebSocket();
})();
