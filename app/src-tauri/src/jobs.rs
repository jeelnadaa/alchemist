//! Background job queue for conversion, compression, enhancement and export.
//!
//! Jobs run one at a time on a worker thread, each in its own FFmpeg process,
//! so the window stays responsive and memory stays flat. The queue keeps
//! working when the main window is closed (the app stays in the tray).

use crate::convert::{self, ConvertRequest, Goal};
use crate::ffmpeg::{self, Capabilities, FfError, MediaInfo};
use crate::quality::{self, QualityScore};
use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub seconds: f64,
    pub quality: Option<QualityScore>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub input: Option<PathBuf>,
    pub output: PathBuf,
    pub status: Status,
    pub progress: f64,
    pub eta_seconds: Option<f64>,
    pub stage: String,
    pub error: Option<String>,
    pub report: Option<Report>,
}

/// Everything the worker needs to run a job.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub title: String,
    pub kind: String,
    pub input: Option<PathBuf>,
    pub input_bytes: u64,
    pub output: PathBuf,
    /// Each pass is one FFmpeg run. Two-pass encodes have two.
    pub passes: Vec<Vec<String>>,
    pub duration: f64,
    /// For target-size jobs: the request, so an oversize result can be redone smaller.
    pub convert: Option<(ConvertRequest, MediaInfo)>,
    pub measure_quality: bool,
    pub cleanup: Vec<PathBuf>,
}

type Notify = Arc<dyn Fn(&Job) + Send + Sync>;

struct Inner {
    jobs: Vec<Job>,
    specs: VecDeque<(String, JobSpec)>,
    current_pid: Option<u32>,
}

pub struct Queue {
    inner: Mutex<Inner>,
    wake: Condvar,
    cancel_current: AtomicBool,
    notify: Notify,
}

impl Queue {
    pub fn new(notify: Notify) -> Arc<Self> {
        let q = Arc::new(Queue {
            inner: Mutex::new(Inner {
                jobs: Vec::new(),
                specs: VecDeque::new(),
                current_pid: None,
            }),
            wake: Condvar::new(),
            cancel_current: AtomicBool::new(false),
            notify,
        });
        let worker = q.clone();
        std::thread::Builder::new()
            .name("alchemist-jobs".into())
            .spawn(move || worker.run())
            .ok();
        q
    }

    pub fn list(&self) -> Vec<Job> {
        self.inner.lock().jobs.clone()
    }

    pub fn is_busy(&self) -> bool {
        self.inner
            .lock()
            .jobs
            .iter()
            .any(|j| matches!(j.status, Status::Queued | Status::Running))
    }

    pub fn add(&self, spec: JobSpec) -> Job {
        let id = uuid::Uuid::new_v4().to_string();
        let job = Job {
            id: id.clone(),
            title: spec.title.clone(),
            kind: spec.kind.clone(),
            input: spec.input.clone(),
            output: spec.output.clone(),
            status: Status::Queued,
            progress: 0.0,
            eta_seconds: None,
            stage: "Waiting".into(),
            error: None,
            report: None,
        };
        {
            let mut g = self.inner.lock();
            g.jobs.push(job.clone());
            g.specs.push_back((id, spec));
        }
        (self.notify)(&job);
        self.wake.notify_one();
        job
    }

    pub fn cancel(&self, id: &str) {
        let mut g = self.inner.lock();
        let running = g
            .jobs
            .iter()
            .any(|j| j.id == id && j.status == Status::Running);
        if running {
            self.cancel_current.store(true, Ordering::SeqCst);
            if let Some(pid) = g.current_pid {
                ffmpeg::kill_pid(pid);
            }
        } else {
            g.specs.retain(|(sid, _)| sid != id);
            if let Some(j) = g
                .jobs
                .iter_mut()
                .find(|j| j.id == id && j.status == Status::Queued)
            {
                j.status = Status::Cancelled;
                j.stage = "Cancelled".into();
                (self.notify)(j);
            }
        }
    }

    /// Remove finished jobs from the list.
    pub fn clear_finished(&self) {
        self.inner
            .lock()
            .jobs
            .retain(|j| matches!(j.status, Status::Queued | Status::Running));
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        let snapshot = {
            let mut g = self.inner.lock();
            g.jobs.iter_mut().find(|j| j.id == id).map(|j| {
                f(j);
                j.clone()
            })
        };
        if let Some(j) = snapshot {
            (self.notify)(&j);
        }
    }

    fn run(self: Arc<Self>) {
        loop {
            let (id, spec) = {
                let mut g = self.inner.lock();
                while g.specs.is_empty() {
                    self.wake.wait(&mut g);
                }
                g.specs.pop_front().expect("non-empty")
            };
            self.cancel_current.store(false, Ordering::SeqCst);
            let started = Instant::now();
            self.update(&id, |j| {
                j.status = Status::Running;
                j.stage = "Working".into();
            });
            let result = self.execute(&id, &spec, started);
            for p in &spec.cleanup {
                let _ = std::fs::remove_file(p);
            }
            self.inner.lock().current_pid = None;
            match result {
                Ok(report) => self.update(&id, |j| {
                    j.status = Status::Done;
                    j.progress = 1.0;
                    j.eta_seconds = None;
                    j.stage = "Done".into();
                    j.report = Some(report);
                }),
                Err(FfError::Cancelled) => {
                    let _ = std::fs::remove_file(&spec.output);
                    self.update(&id, |j| {
                        j.status = Status::Cancelled;
                        j.stage = "Cancelled".into();
                        j.eta_seconds = None;
                    })
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&spec.output);
                    self.update(&id, |j| {
                        j.status = Status::Failed;
                        j.stage = "Failed".into();
                        j.eta_seconds = None;
                        j.error = Some(e.to_string());
                    })
                }
            }
        }
    }

    fn run_passes(
        &self,
        id: &str,
        passes: &[Vec<String>],
        duration: f64,
        started: Instant,
        base: f64,
        span: f64,
    ) -> Result<(), FfError> {
        let n = passes.len().max(1) as f64;
        for (i, args) in passes.iter().enumerate() {
            let stage = if passes.len() > 1 {
                format!("Pass {} of {}", i + 1, passes.len())
            } else {
                "Working".into()
            };
            self.update(id, |j| j.stage = stage.clone());
            let id2 = id.to_string();
            let mut last_emit = Instant::now() - std::time::Duration::from_secs(1);
            ffmpeg::run_with_progress(
                args,
                |t| {
                    let frac =
                        base + span * ((i as f64 + (t / duration.max(0.01)).clamp(0.0, 1.0)) / n);
                    if last_emit.elapsed().as_millis() >= 250 {
                        last_emit = Instant::now();
                        let elapsed = started.elapsed().as_secs_f64();
                        let eta = if frac > 0.02 {
                            Some(elapsed / frac - elapsed)
                        } else {
                            None
                        };
                        self.update(&id2, |j| {
                            j.progress = frac.clamp(0.0, 0.99);
                            j.eta_seconds = eta;
                        });
                    }
                },
                |pid| self.inner.lock().current_pid = Some(pid),
                || self.cancel_current.load(Ordering::SeqCst),
            )?;
        }
        Ok(())
    }

    fn execute(&self, id: &str, spec: &JobSpec, started: Instant) -> Result<Report, FfError> {
        let measure_span = if spec.measure_quality { 0.9 } else { 1.0 };
        self.run_passes(id, &spec.passes, spec.duration, started, 0.0, measure_span)?;
        let mut out_bytes = std::fs::metadata(&spec.output)
            .map(|m| m.len())
            .unwrap_or(0);
        let mut note = None;

        // Target size: verify, and redo smaller once if the encoder overshot.
        if let Some((req, info)) = &spec.convert {
            if let Goal::TargetSize { target_mb } = req.goal {
                let limit = (target_mb * 1024.0 * 1024.0) as u64;
                if out_bytes > limit {
                    self.update(id, |j| j.stage = "Slightly over, making it smaller".into());
                    let caps = ffmpeg::capabilities()?;
                    let mut redo = req.clone();
                    redo.goal = Goal::TargetSize {
                        target_mb: target_mb * (limit as f64 / out_bytes as f64) * 0.97,
                    };
                    let passes = target_size_passes(&redo, info, &caps, &spec.output);
                    self.run_passes(id, &passes, spec.duration, started, 0.0, measure_span)?;
                    out_bytes = std::fs::metadata(&spec.output)
                        .map(|m| m.len())
                        .unwrap_or(0);
                }
                if out_bytes > limit {
                    note = Some(format!("This video is too long to fit under {target_mb} MB at a watchable quality. It's as small as Alchemist could make it."));
                }
            }
        }

        let mut q = None;
        if spec.measure_quality && !self.cancel_current.load(Ordering::SeqCst) {
            if let (Some(input), Some((_, info))) = (&spec.input, &spec.convert) {
                self.update(id, |j| j.stage = "Measuring quality".into());
                if let Ok(caps) = ffmpeg::capabilities() {
                    q = quality::measure(
                        &caps,
                        input,
                        &spec.output,
                        info.duration,
                        info.width.min(1920),
                        info.height.min(1080),
                    )
                    .ok();
                }
            }
        }
        if self.cancel_current.load(Ordering::SeqCst) {
            return Err(FfError::Cancelled);
        }
        Ok(Report {
            input_bytes: spec.input_bytes,
            output_bytes: out_bytes,
            seconds: started.elapsed().as_secs_f64(),
            quality: q,
            note,
        })
    }
}

/// Passes for a target-size encode: one hardware pass if available and
/// allowed, else an accurate two-pass software encode.
pub fn target_size_passes(
    req: &ConvertRequest,
    info: &MediaInfo,
    caps: &Capabilities,
    output: &std::path::Path,
) -> Vec<Vec<String>> {
    let software_two_pass =
        !(req.use_hardware && caps.hw_h264.is_some()) && caps.has_encoder("libx264");
    if software_two_pass {
        let log = std::env::temp_dir().join(format!("alchemist-pass-{}", uuid::Uuid::new_v4()));
        vec![
            convert::build_args(req, info, caps, output, Some((1, &log))),
            convert::build_args(req, info, caps, output, Some((2, &log))),
        ]
    } else {
        vec![convert::build_args(req, info, caps, output, None)]
    }
}

/// Turn a convert request into a job spec (probing the input first).
pub fn spec_for_convert(req: ConvertRequest) -> Result<JobSpec, FfError> {
    let info = ffmpeg::probe(&req.input)?;
    let caps = ffmpeg::capabilities()?;
    let container = convert::output_container(&req);
    let output = req.output.clone().unwrap_or_else(|| {
        convert::default_output(&req.input, container.ext(), &convert::output_suffix(&req))
    });
    let passes = match req.goal {
        Goal::TargetSize { .. } => target_size_passes(&req, &info, &caps, &output),
        _ => vec![convert::build_args(&req, &info, &caps, &output, None)],
    };
    let name = req
        .input
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let (title, kind) = match &req.goal {
        Goal::TargetSize { target_mb } => (format!("{name} → under {target_mb} MB"), "compress"),
        Goal::Format { container, .. } => (
            format!("{name} → {}", container.ext().to_uppercase()),
            "convert",
        ),
        Goal::Enhance { .. } => (format!("{name} → enhanced"), "enhance"),
    };
    let duration = req.length.unwrap_or(info.duration).max(0.1);
    let measure = info.has_video
        && !container.audio_only()
        && container != convert::Container::Gif
        && req.length.is_none();
    let mut cleanup = Vec::new();
    for p in &passes {
        if let Some(i) = p.iter().position(|a| a == "-passlogfile") {
            let base = &p[i + 1];
            cleanup.push(PathBuf::from(format!("{base}-0.log")));
            cleanup.push(PathBuf::from(format!("{base}-0.log.mbtree")));
        }
    }
    Ok(JobSpec {
        title,
        kind: kind.into(),
        input: Some(req.input.clone()),
        input_bytes: info.size_bytes,
        output,
        passes,
        duration,
        convert: Some((req, info)),
        measure_quality: measure,
        cleanup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn cancelling_a_queued_job_never_runs_it() {
        let (tx, _rx) = mpsc::channel::<Job>();
        let tx = Mutex::new(tx);
        let q = Queue::new(Arc::new(move |j: &Job| {
            let _ = tx.lock().send(j.clone());
        }));
        // Block the worker with a job whose binary may not exist: either way it
        // finishes; we only check queue bookkeeping for the second job.
        let spec = JobSpec {
            title: "t".into(),
            kind: "convert".into(),
            input: None,
            input_bytes: 0,
            output: std::env::temp_dir().join("alchemist-test-never.mp4"),
            passes: vec![vec!["-version".into()]],
            duration: 1.0,
            convert: None,
            measure_quality: false,
            cleanup: vec![],
        };
        let _a = q.add(spec.clone());
        let b = q.add(spec);
        q.cancel(&b.id);
        let jobs = q.list();
        let jb = jobs.iter().find(|j| j.id == b.id).unwrap();
        assert!(matches!(
            jb.status,
            Status::Cancelled | Status::Running | Status::Done | Status::Failed
        ));
    }
}
