import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Check, ChevronLeft, ChevronRight, FileText, FolderOpen, Info, MessageSquareText, ShieldCheck, Trash2, UploadCloud, UserRound } from "lucide-react";
import { useStakeholder } from "../../context/StakeholderContext";
import { stakeholderApi } from "../../services/stakeholder";

const categories = [
  ["WITHHOLDING_DOCUMENTS", "Withholding original certificates / degrees"],
  ["EXCESS_FEE", "Excess / capitation fee demand"],
  ["RAGGING_HARASSMENT", "Ragging or harassment"],
  ["FACULTY_SALARY_SERVICE", "Faculty salary / service conditions"],
  ["INFRASTRUCTURE_LAB_DEFICIT", "Laboratory / infrastructure violation"],
  ["FEES", "Fee-related concern"],
  ["DOCUMENTS", "Document-related concern"],
  ["ACADEMIC", "Academic concern"],
  ["FACILITIES", "Facilities concern"],
  ["SALARY_SERVICE", "Salary / service conditions"],
  ["SAFETY", "Safety concern"],
  ["OTHER", "Other"],
];
const acceptedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const acceptedExtensions = /\.(pdf|jpe?g|png)$/i;
const maxFileSize = 10 * 1024 * 1024;
const maxFiles = 5;

function roleLabel(role) {
  return role === "faculty" ? "Faculty" : "Student";
}

function institutionLabel(institution) {
  if (!institution) return "";
  return `${institution.name}${institution.aicte_id ? ` (${institution.aicte_id})` : ""}${institution.state ? ` · ${institution.state}` : ""}`;
}

function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function FileRow({ file, onRemove, disabled }) {
  return <div className="complaint-upload-file">
    <span><FileText size={17} /></span>
    <div><strong>{file.name}</strong><small>{(file.size / (1024 * 1024)).toFixed(2)} MB</small></div>
    <button type="button" className="complaint-remove-file" aria-label={`Remove ${file.name}`} onClick={onRemove} disabled={disabled}><Trash2 size={15} /></button>
  </div>;
}

export default function ComplaintFormPage() {
  const { institution, role, reload } = useStakeholder();
  const navigate = useNavigate();
  const institutionListId = useId();
  const fileInputRef = useRef(null);
  const uploadedFiles = useRef(new Set());
  const [institutions, setInstitutions] = useState([]);
  const [institutionId, setInstitutionId] = useState("");
  const [institutionQuery, setInstitutionQuery] = useState("");
  const [category, setCategory] = useState("OTHER");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState([]);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdComplaintId, setCreatedComplaintId] = useState("");

  const institutionOptions = useMemo(() => institutions.map((item) => ({
    ...item,
    label: institutionLabel(item),
  })), [institutions]);
  const selectedInstitution = institutionOptions.find((item) => item._id === institutionId);
  const categoryLabel = categories.find(([value]) => value === category)?.[1] || "Other";
  const currentRole = roleLabel(role);

  useEffect(() => {
    let active = true;
    stakeholderApi.getComplaintInstitutions()
      .then((items) => {
        if (!Array.isArray(items)) throw new Error("The college directory response was invalid.");
        if (!active) return;
        setInstitutions(items);
        const linked = items.find((item) => item._id === institution?._id);
        if (linked) {
          setInstitutionId(linked._id);
          setInstitutionQuery(institutionLabel(linked));
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "The college directory could not be loaded.");
      });
    return () => { active = false; };
  }, [institution?._id]);

  function validateComplaintDetails() {
    if (!institutionId) {
      setError("Select the college your complaint is about.");
      return false;
    }
    if (subject.trim().length < 5) {
      setError("Enter a subject with at least 5 characters.");
      return false;
    }
    if (subject.trim().length > 160) {
      setError("The subject must be 160 characters or fewer.");
      return false;
    }
    if (description.trim().length < 20) {
      setError("Describe the issue in at least 20 characters.");
      return false;
    }
    if (description.trim().length > 5000) {
      setError("The description must be 5,000 characters or fewer.");
      return false;
    }
    setError("");
    return true;
  }

  function addFiles(fileList) {
    const selected = Array.from(fileList || []);
    if (!selected.length) return;
    const knownFileKeys = new Set(files.map(fileKey));
    const uniqueSelected = selected.filter((file) => {
      const key = fileKey(file);
      if (knownFileKeys.has(key)) return false;
      knownFileKeys.add(key);
      return true;
    });
    if (!uniqueSelected.length) return;
    if (files.length + uniqueSelected.length > maxFiles) {
      setError(`Attach no more than ${maxFiles} evidence files.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const invalidFile = uniqueSelected.find((file) => !acceptedMimeTypes.has(file.type) && !acceptedExtensions.test(file.name));
    if (invalidFile) {
      setError(`${invalidFile.name} is not a supported file. Choose a PDF, JPEG, or PNG.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const oversizedFile = uniqueSelected.find((file) => file.size > maxFileSize);
    if (oversizedFile) {
      setError(`${oversizedFile.name} exceeds the 10 MB limit.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setError("");
    setFiles((current) => [...current, ...uniqueSelected]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index) {
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
    setError("");
  }

  function continueToEvidence() {
    if (!validateComplaintDetails()) return;
    setStep(2);
  }

  function continueToReview() {
    if (files.length > maxFiles || files.some((file) => file.size > maxFileSize)) {
      setError("Check the selected files. You can attach up to five files, each 10 MB or smaller.");
      return;
    }
    setError("");
    setStep(3);
  }

  async function submit(event) {
    event.preventDefault();
    if (!validateComplaintDetails()) {
      setStep(1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      let complaintId = createdComplaintId;
      if (!complaintId) {
        const complaint = await stakeholderApi.createComplaint({
          institution_id: institutionId,
          category,
          subject: subject.trim(),
          description: description.trim(),
        });
        if (!complaint?._id) throw new Error("The complaint was created without a reference. Contact support before trying again.");
        complaintId = complaint._id;
        setCreatedComplaintId(complaintId);
      }
      for (const file of files) {
        const key = fileKey(file);
        if (uploadedFiles.current.has(key)) continue;
        await stakeholderApi.uploadComplaintEvidence(complaintId, file);
        uploadedFiles.current.add(key);
      }
      await reload();
      navigate(`/${role}/complaints`, { state: { created: complaintId } });
    } catch (submitError) {
      setError(submitError.message || "Your complaint could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    { number: 1, title: "Complaint Details", description: "Provide basic information" },
    { number: 2, title: "Evidence Upload", description: "Attach supporting documents" },
    { number: 3, title: "Review & Submit", description: "Verify and submit your complaint" },
  ];

  return <div className="stakeholder-page complaint-page">
    <div className="complaint-page-heading">
      <h1>Lodge a Complaint</h1>
      <p>Submit a confidential complaint to AICTE and track its review and redressal.</p>
    </div>

    <div className="complaint-confidentiality-note">
      <span className="complaint-info-icon"><Info size={20} /></span>
      <div className="complaint-confidentiality-copy">
        <strong>Your identity is confidential</strong>
        <p>Your personal details are not shown to the college. Before attaching evidence, redact your name, email, phone number, student enrollment number, or faculty employee ID from both the document contents and file name. Avoid passwords, payment-card information, and unrelated sensitive details.</p>
      </div>
      <div className="complaint-supported-files"><span><FileText size={19} /></span><div><strong>Supported files</strong><small>PDF, JPEG, PNG<br />Max 10 MB each</small></div></div>
    </div>

    <ol className="complaint-stepper" aria-label="Complaint submission steps">
      {steps.map((item, index) => <li className={step === item.number ? "active" : step > item.number ? "complete" : ""} key={item.number}>
        <span className="complaint-step-number">{step > item.number ? <Check size={17} /> : item.number}</span>
        <span className="complaint-step-copy"><strong>{item.title}</strong><small>{item.description}</small></span>
        {index < steps.length - 1 && <span className="complaint-step-connector" aria-hidden="true" />}
      </li>)}
    </ol>

    <form className="complaint-form" onSubmit={submit} noValidate>
      {step === 1 && <section className="complaint-form-card">
        <header className="complaint-section-heading">
          <span>1</span><div><h2>Complaint details</h2><p>Tell us about the issue you are facing. Please provide accurate and clear information.</p></div>
        </header>
        <div className="complaint-field-grid">
          <label className="complaint-field-card institution">
            <span className="complaint-field-icon"><Building2 size={19} /></span>
            <span className="complaint-field-content"><strong>College / Institution <i>*</i></strong>
              <input
                list={institutionListId}
                value={institutionQuery}
                onChange={(event) => {
                  setInstitutionQuery(event.target.value);
                  const selected = institutionOptions.find((item) => item.label.toLowerCase() === event.target.value.trim().toLowerCase());
                  setInstitutionId(selected?._id || "");
                  if (error) setError("");
                }}
                placeholder="Search college name or AICTE ID"
                required
                aria-required="true"
                disabled={Boolean(createdComplaintId)}
              />
              <datalist id={institutionListId}>{institutionOptions.map((item) => <option key={item._id} value={item.label} />)}</datalist>
            </span>
          </label>
          <label className="complaint-field-card role">
            <span className="complaint-field-icon"><UserRound size={18} /></span>
            <span className="complaint-field-content"><strong>Complainant role</strong><input value={currentRole} readOnly /></span>
          </label>
          <label className="complaint-field-card category">
            <span className="complaint-field-icon"><FolderOpen size={18} /></span>
            <span className="complaint-field-content"><strong>Category <i>*</i></strong>
              <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={Boolean(createdComplaintId)} required>
                {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </span>
          </label>
          <label className="complaint-field-row">
            <span className="complaint-field-icon"><FileText size={18} /></span>
            <span className="complaint-field-content"><strong>Subject <i>*</i></strong>
              <span className="complaint-input-with-count"><input required minLength={5} maxLength={160} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Enter a brief subject for your complaint" disabled={Boolean(createdComplaintId)} /><small>{subject.length}/160</small></span>
            </span>
          </label>
          <label className="complaint-field-row description">
            <span className="complaint-field-icon"><MessageSquareText size={18} /></span>
            <span className="complaint-field-content"><strong>Describe the issue <i>*</i></strong>
              <span className="complaint-input-with-count"><textarea required minLength={20} maxLength={5000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Provide a detailed description of the issue. Include relevant dates, events, and any actions already taken." disabled={Boolean(createdComplaintId)} /><small>{description.length}/5000</small></span>
            </span>
          </label>
        </div>
        <p className="complaint-private-footnote"><ShieldCheck size={15} />Your {currentRole.toLowerCase()} identity is recorded privately for AICTE review and is not shared with the college.</p>
      </section>}

      {step === 2 && <section className="complaint-form-card">
        <header className="complaint-section-heading">
          <span>2</span><div><h2>Evidence upload</h2><p>Attach relevant files to help AICTE review your complaint. Evidence is optional.</p></div>
        </header>
        <div className="complaint-evidence-summary">
          <div><strong>{subject.trim()}</strong><small>{selectedInstitution?.label || institutionQuery} · {categoryLabel}</small></div>
          <button type="button" className="complaint-inline-edit" onClick={() => setStep(1)}><ChevronLeft size={14} /> Edit details</button>
        </div>
        <div className={`complaint-dropzone${files.length ? " has-files" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        }}>
          <span><UploadCloud size={24} /></span>
          <strong>Drag and drop your files here</strong>
          <small>PDF, JPEG or PNG · Up to {maxFiles} files · Maximum 10 MB per file</small>
          <button className="stakeholder-button secondary small" type="button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(createdComplaintId)}>Browse files</button>
          <input ref={fileInputRef} className="complaint-file-input" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple onChange={(event) => addFiles(event.target.files)} disabled={Boolean(createdComplaintId)} />
        </div>
        {files.length > 0 && <div className="complaint-upload-list" aria-label="Attached evidence files">
          <div className="complaint-upload-list-heading"><strong>Attached files ({files.length}/{maxFiles})</strong><small>Each file must be 10 MB or smaller.</small></div>
          {files.map((file, index) => <FileRow file={file} key={fileKey(file)} disabled={Boolean(createdComplaintId)} onRemove={() => removeFile(index)} />)}
        </div>}
        <div className="complaint-evidence-privacy"><ShieldCheck size={17} /><span><strong>Protect your privacy</strong><small>Remove personal identifiers from both file contents and file names before uploading.</small></span></div>
      </section>}

      {step === 3 && <section className="complaint-form-card">
        <header className="complaint-section-heading">
          <span>3</span><div><h2>Review & submit</h2><p>Check your complaint details before sending them to AICTE.</p></div>
        </header>
        <div className="complaint-review-list">
          <article><small>College / Institution</small><strong>{selectedInstitution?.label || institutionQuery}</strong><button type="button" onClick={() => setStep(1)}>Edit</button></article>
          <article><small>Complainant role</small><strong>{currentRole}</strong></article>
          <article><small>Category</small><strong>{categoryLabel}</strong><button type="button" onClick={() => setStep(1)}>Edit</button></article>
          <article><small>Subject</small><strong>{subject.trim()}</strong><button type="button" onClick={() => setStep(1)}>Edit</button></article>
          <article className="full"><small>Describe the issue</small><strong>{description.trim()}</strong><button type="button" onClick={() => setStep(1)}>Edit</button></article>
          <article className="full"><small>Evidence files</small>{files.length
            ? <div className="complaint-review-files">{files.map((file) => <span key={fileKey(file)}><FileText size={14} />{file.name}</span>)}</div>
            : <strong>No evidence attached</strong>}<button type="button" onClick={() => setStep(2)}>Edit</button></article>
        </div>
        <div className="complaint-review-confidential"><ShieldCheck size={17} /><span>Your identity and personal account details remain confidential and are not shown to the college.</span></div>
      </section>}

      {error && <p className="complaint-form-error" role="alert">{error}</p>}
      <footer className="complaint-form-actions">
        {step > 1
          ? <button className="stakeholder-button secondary" type="button" onClick={() => { setError(""); setStep((current) => current - 1); }} disabled={busy}><ChevronLeft size={16} /> Back</button>
          : <span />}
        {step === 1
          ? <button className="stakeholder-button primary" type="button" onClick={continueToEvidence}>Continue to evidence <ChevronRight size={16} /></button>
          : step === 2
            ? <button className="stakeholder-button primary" type="button" onClick={continueToReview}>Review complaint <ChevronRight size={16} /></button>
            : <button className="stakeholder-button primary" type="submit" disabled={busy}>{busy ? "Submitting complaint…" : "Submit complaint"} {!busy && <Check size={16} />}</button>}
      </footer>
    </form>
  </div>;
}
