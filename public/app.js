(function () {
  'use strict';

  // --- State ---
  var selectedFiles = [];
  var clientId = null;
  var ws = null;
  var activeJobs = {};
  var totalJobs = 0;
  var completedOrFailedCount = 0;

  // --- DOM refs ---
  var dropZone = document.getElementById('dropZone');
  var fileInput = document.getElementById('fileInput');
  var fileList = document.getElementById('fileList');
  var transcribeBtn = document.getElementById('transcribeBtn');
  var jobsSection = document.getElementById('jobsSection');
  var uploadSection = document.getElementById('uploadSection');
  var optionsSection = document.getElementById('optionsSection');
  var languageSelect = document.getElementById('languageSelect');

  // --- WebSocket ---
  function connectWebSocket() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.addEventListener('open', function () {
      console.log('[WS] Connected');
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
      clientId = null;
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
        var stageLabel = msg.stage === 'converting' ? 'Converting audio' : 'Transcribing';
        updateJobCard(msg.jobId, {
          status: msg.stage,
          statusText: stageLabel + '... ' + msg.percent + '%',
          percent: msg.percent,
        });
        break;

      case 'job_completed':
        updateJobCard(msg.jobId, {
          status: 'completed',
          statusText: 'Completed',
          percent: 100,
          outputs: msg.outputs,
        });
        completedOrFailedCount++;
        checkAllDone();
        break;

      case 'job_failed':
        updateJobCard(msg.jobId, {
          status: 'failed',
          statusText: 'Failed',
          percent: 100,
          error: msg.error,
        });
        completedOrFailedCount++;
        checkAllDone();
        break;
    }
  }

  // --- File handling ---
  function addFiles(newFiles) {
    for (var i = 0; i < newFiles.length; i++) {
      // Avoid duplicates by name+size
      var dup = selectedFiles.some(function (f) {
        return f.name === newFiles[i].name && f.size === newFiles[i].size;
      });
      if (!dup) {
        selectedFiles.push(newFiles[i]);
      }
    }
    renderFileList();
    updateTranscribeBtn();
  }

  function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
    updateTranscribeBtn();
  }

  function renderFileList() {
    fileList.innerHTML = '';
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

  // --- Transcribe ---
  function updateTranscribeBtn() {
    transcribeBtn.disabled = selectedFiles.length === 0;
  }

  transcribeBtn.addEventListener('click', function () {
    if (selectedFiles.length === 0) return;

    var formats = getSelectedFormats();
    if (formats.length === 0) {
      alert('Please select at least one output format.');
      return;
    }

    if (!clientId) {
      alert('Not connected to the server. Please wait a moment and try again.');
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

    // UI: disable upload, show processing state
    setProcessingState(true);
    jobsSection.innerHTML = '';
    activeJobs = {};
    totalJobs = selectedFiles.length;
    completedOrFailedCount = 0;

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
      })
      .catch(function (err) {
        alert('Error: ' + err.message);
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
    } else {
      uploadSection.classList.remove('disabled');
      optionsSection.classList.remove('disabled');
      transcribeBtn.classList.remove('processing');
      transcribeBtn.innerHTML = 'Start Transcription';
      // Keep disabled if no files
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
      '<div class="progress-bar-fill" id="bar-' + jobId + '"></div>' +
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
    if (data.percent !== undefined) {
      bar.style.width = data.percent + '%';
      bar.className = 'progress-bar-fill';
      if (data.status === 'converting') bar.classList.add('converting');
      else if (data.status === 'completed') bar.classList.add('completed');
      else if (data.status === 'failed') bar.classList.add('failed');
    }

    // Update progress text
    if (data.statusText) {
      ptext.textContent = data.statusText;
    }

    // Show downloads
    if (data.status === 'completed' && data.outputs) {
      var html = '<div class="job-downloads">';
      data.outputs.forEach(function (o) {
        html +=
          '<a class="btn-download" href="' + o.downloadUrl + '" download>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
          '<polyline points="7 10 12 15 17 10"/>' +
          '<line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          o.format.toUpperCase() +
          '</a>';
      });
      html += '</div>';
      downloads.innerHTML = html;
    }

    // Show error
    if (data.status === 'failed' && data.error) {
      downloads.innerHTML = '<div class="job-error">' + escapeHtml(data.error) + '</div>';
    }
  }

  function checkAllDone() {
    if (completedOrFailedCount >= totalJobs) {
      transcribeBtn.classList.remove('processing');
      transcribeBtn.innerHTML = 'Start Transcription';

      // Show reset button
      var resetDiv = document.createElement('div');
      resetDiv.style.textAlign = 'center';
      resetDiv.innerHTML = '<button class="btn-reset" id="resetBtn">Transcribe more files</button>';
      jobsSection.appendChild(resetDiv);

      document.getElementById('resetBtn').addEventListener('click', function () {
        setProcessingState(false);
        jobsSection.innerHTML = '';
      });
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

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // --- Init ---
  connectWebSocket();
})();
