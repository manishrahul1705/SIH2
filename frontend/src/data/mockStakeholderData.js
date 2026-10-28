export const institutionProfile = {
  name: "Sri Vidya Institute of Engineering and Technology",
  location: "Coimbatore, Tamil Nadu",
  permanentId: "1-492817462",
  affiliation: "Anna University, Chennai",
  type: "Private Self-Financed",
  academicYear: "2026-27",
  approvalStatus: "EoA Granted for 2026-27",
  latestEoaDate: "18 June 2026",
  accreditingBodies: ["NBA", "NAAC"],
  facultyStudentRatio: "1:18.5",
  requiredRatio: "1:20",
  cadreRatio: "1:2:6",
};

export const approvedOfferings = [
  { level: "UG", name: "B.Tech Computer Science and Engineering", shift: "1st", intake: 180, nba: "Accredited", nbaValid: "30 June 2028", fee: 85000, placement: "2025 placement summary" },
  { level: "UG", name: "B.Tech Information Technology", shift: "1st", intake: 120, nba: "Accredited", nbaValid: "30 June 2027", fee: 82000, placement: "2025 placement summary" },
  { level: "UG", name: "B.E. Electronics and Communication Engineering", shift: "1st", intake: 120, nba: "Not Accredited", nbaValid: "", fee: 80000, placement: "2025 placement summary" },
  { level: "UG", name: "B.E. Mechanical Engineering", shift: "1st", intake: 60, nba: "Not Accredited", nbaValid: "", fee: 76000, placement: "2025 placement summary" },
  { level: "UG", name: "B.E. Electrical and Electronics Engineering", shift: "1st", intake: 60, nba: "Not Accredited", nbaValid: "", fee: 76000, placement: "2025 placement summary" },
  { level: "PG", name: "M.Tech VLSI Design", shift: "1st", intake: 18, nba: "Not Accredited", nbaValid: "", fee: 95000, placement: "Programme disclosure" },
  { level: "PG", name: "M.E. Computer Science and Engineering", shift: "1st", intake: 18, nba: "Not Accredited", nbaValid: "", fee: 90000, placement: "Programme disclosure" },
  { level: "Diploma", name: "Diploma in Computer Engineering", shift: "2nd", intake: 60, nba: "Not Accredited", nbaValid: "", fee: 52000, placement: "Programme disclosure" },
];

export const safetyCertificates = [
  { name: "Fire Safety Certificate", issuer: "Tamil Nadu Fire and Rescue Services", issued: "12 May 2026", expires: "11 May 2027", status: "Verified Active" },
  { name: "Structural Stability Certificate", issuer: "Registered Structural Engineer", issued: "04 April 2025", expires: "03 April 2030", status: "Verified Active" },
  { name: "Occupancy Certificate", issuer: "Coimbatore City Municipal Corporation", issued: "16 February 2024", expires: "No fixed expiry", status: "Verified Active" },
  { name: "Potable Water Certificate", issuer: "Accredited Testing Laboratory", issued: "02 August 2026", expires: "01 August 2027", status: "Verified Active" },
  { name: "Sanitary Certificate", issuer: "District Health Office", issued: "02 August 2026", expires: "01 August 2027", status: "Verified Active" },
  { name: "Anti-Ragging Undertaking", issuer: "Institution Nodal Officer", issued: "10 June 2026", expires: "31 May 2027", status: "Verified Active" },
];

export const facilities = {
  area: "24,850 sq. m.",
  laboratories: [
    { department: "Computer Science and Engineering", count: 8, status: "Equipment register verified" },
    { department: "Electronics and Communication", count: 6, status: "Equipment register verified" },
    { department: "Mechanical Engineering", count: 5, status: "Equipment register verified" },
    { department: "Electrical and Electronics", count: 4, status: "Equipment register verified" },
  ],
  library: { volumes: "42,600", journals: "186 national / 92 international", consortium: "INFLIBNET e-ShodhSindhu" },
  computing: { terminals: 920, bandwidth: "1 Gbps leased line" },
  hostel: { capacity: 860, mess: "Two dining halls; vegetarian and non-vegetarian kitchens" },
  accessibility: ["Ramps at all academic blocks", "Lifts in Blocks A and B", "Accessible washrooms on each floor"],
  medical: "Campus first-aid room with nurse during college hours",
};

export const departmentRoster = [
  { department: "Computer Science and Engineering", professor: { required: 2, available: 2 }, associate: { required: 4, available: 4 }, assistant: { required: 12, available: 11 }, phd: 12, labs: ["Programming Lab", "AI and Data Science Lab", "Networks Lab", "Project Lab"] },
  { department: "Electronics and Communication Engineering", professor: { required: 2, available: 2 }, associate: { required: 3, available: 3 }, assistant: { required: 9, available: 8 }, phd: 8, labs: ["VLSI Lab", "Communication Systems Lab", "Embedded Systems Lab"] },
  { department: "Mechanical Engineering", professor: { required: 1, available: 1 }, associate: { required: 2, available: 2 }, assistant: { required: 6, available: 6 }, phd: 5, labs: ["Manufacturing Lab", "Thermal Engineering Lab", "CAD Lab"] },
  { department: "Electrical and Electronics Engineering", professor: { required: 1, available: 1 }, associate: { required: 2, available: 2 }, assistant: { required: 6, available: 5 }, phd: 4, labs: ["Power Systems Lab", "Electrical Machines Lab", "Control Systems Lab"] },
];

export const committeeContacts = [
  { name: "Student Grievance Redressal Committee", short: "SGRC", lead: "Dr. R. Venkatesan, Chairperson", email: "sgrc@srividhya.example", phone: "+91 422 555 0140", hours: "Monday-Friday, 9:30 AM-4:30 PM", detail: "Academic, examination, fee, and student-service grievances." },
  { name: "Anti-Ragging Committee and Squad", short: "ARC", lead: "Dr. Meena Balasubramanian, Nodal Officer", email: "antiragging@srividhya.example", phone: "+91 422 555 0141", hours: "24-hour campus helpline", detail: "Immediate student safety reports and anti-ragging support." },
  { name: "Internal Complaints Committee", short: "ICC / POSH", lead: "Adv. Latha Krishnan, Presiding Officer", email: "icc@srividhya.example", phone: "+91 422 555 0142", hours: "By confidential appointment", detail: "Workplace and campus sexual-harassment complaints." },
  { name: "SC/ST/OBC Cell", short: "Equal Opportunity Cell", lead: "Prof. S. Rajendran, Coordinator", email: "equalopportunity@srividhya.example", phone: "+91 422 555 0143", hours: "Monday-Friday, 10:00 AM-4:00 PM", detail: "Equal-opportunity guidance, support, and referrals." },
  { name: "University Ombudsperson", short: "Anna University", lead: "Office of the University Ombudsperson", email: "ombudsperson@annauniv.example", phone: "+91 44 555 0210", hours: "By appointment", detail: "External escalation information for unresolved student grievances." },
];

export const complaintCategories = {
  student: [
    "Unapproved Course or Excess Intake Admission",
    "Original Certificates / Marksheets Withheld by College",
    "Excess Fee Demand or Non-Refund of Fees on Cancellation",
    "Laboratory, Equipment, or Library Deficiency",
    "Hostel, Sanitation, Fire, or Building Safety Hazard",
    "Scholarship / AICTE Stipend Disbursement Delay",
    "Ragging, Harassment, or SGRC Non-Responsiveness",
  ],
  faculty: [
    "Non-Payment, Delayed Disbursement, or Arbitrary Deduction of Salary",
    "Non-Implementation of Prescribed Pay Scale (6th / 7th CPC)",
    "Original Educational / Experience Certificates Withheld by Management",
    "Ghost Faculty / Coerced Proxy Attendance or Fake Biometric Entry",
    "Coerced Sign-Off on False EVC, Lab Equipment, or Self-Disclosure Records",
    "Unlawful Termination or Denial of Statutory / Academic Leave",
    "Workplace Harassment or ICC Non-Compliance",
  ],
};

export const sampleComplaints = [
  { id: "CMP-2026-00482", role: "student", category: "Laboratory, Equipment, or Library Deficiency", subject: "CSE project lab evening access", severity: "Routine Grievance", privacyMode: "identified", department: "Computer Science and Engineering", createdAt: "2026-10-12", status: "Under SGRC Review", stage: 1, updatedAt: "2026-10-18", officerRemark: "Department response requested; no compliance finding has been made.", internalTicketRef: "SGRC-2216", priorRepresentation: true },
  { id: "CMP-2026-00461", role: "student", category: "Scholarship / AICTE Stipend Disbursement Delay", subject: "Stipend status clarification", severity: "Statutory Non-Compliance", privacyMode: "identified", department: "Campus-Wide / Administration", createdAt: "2026-09-28", status: "Escalated to Regional Officer", stage: 2, updatedAt: "2026-10-20", officerRemark: "Receipt acknowledged for independent review.", internalTicketRef: "SGRC-2130", priorRepresentation: true },
  { id: "CMP-2026-00427", role: "faculty", category: "Non-Implementation of Prescribed Pay Scale (6th / 7th CPC)", subject: "Request for pay-scale review", severity: "Statutory Non-Compliance", privacyMode: "identified", department: "Computer Science and Engineering", createdAt: "2026-09-14", status: "Assigned to College SGRC", stage: 1, updatedAt: "2026-09-22", officerRemark: "The grievance cell has requested supporting documents.", internalTicketRef: "ICC-480", priorRepresentation: true },
  { id: "CMP-2026-00395", role: "faculty", category: "Workplace Harassment or ICC Non-Compliance", subject: "Confidential workplace concern", severity: "Urgent Safety / Certificate Withholding", privacyMode: "confidential", department: "Campus-Wide / Administration", createdAt: "2026-08-31", status: "Regional Scrutiny", stage: 2, updatedAt: "2026-09-05", officerRemark: "Confidential referral acknowledged by the designated regional contact.", internalTicketRef: "", priorRepresentation: false },
];

export const sampleYearlyReports = [
  { id: "FYR-2026-0018", year: "2026-27", status: "Draft", submittedAt: "", returnedReason: "", summary: "Current-year teaching and activity report in progress." },
  { id: "FYR-2025-0091", year: "2025-26", status: "Submitted to HOD", submittedAt: "2026-05-26 14:32", returnedReason: "", summary: "Teaching, mentoring, research, and FDP details submitted for institutional review." },
  { id: "FYR-2024-0064", year: "2024-25", status: "Returned for Correction", submittedAt: "2025-06-02 11:10", returnedReason: "Please attach the semester workload allotment order and clarify the DOI for one publication.", summary: "Previous report returned for additional supporting evidence." },
];

export const facultyProfile = {
  aicteId: "FAC-TN-2019-88412",
  fullName: "Dr. Kavitha Rajan",
  department: "Computer Science and Engineering",
  designation: "Associate Professor",
  appointmentType: "Regular",
  dateOfJoining: "2019-06-10",
  highestQualification: "Ph.D.",
  phdUniversityAndYear: "Anna University, Chennai - 2018",
  payScale: "7th CPC",
  monthlySalary: "98000",
};

export const eoaHistory = [
  { year: "2026-27", status: "EoA Granted", date: "18 June 2026" },
  { year: "2025-26", status: "EoA Granted", date: "21 June 2025" },
  { year: "2024-25", status: "EoA Granted", date: "19 June 2024" },
  { year: "2023-24", status: "EoA Granted", date: "17 June 2023" },
  { year: "2022-23", status: "EoA Granted", date: "20 June 2022" },
];
