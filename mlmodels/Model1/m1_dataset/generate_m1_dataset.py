#!/usr/bin/env python3
"""
ApprovalTrack - M1 (document type) synthetic dataset generator.
All people, institutions, places, numbers and dates are FICTIONAL.
Run:  python generate_m1_dataset.py
Output: m1_documents_full.csv, m1_train.csv, m1_val.csv, m1_test.csv, labels.json
Split rule: by layout_id (a layout never appears in two splits), so val/test
contain wording and structures the model has never seen in training.
"""
import csv, hashlib, json, os, random
from datetime import date, timedelta
from collections import Counter

SEED = 2026
PER_CLASS = 1200
OUT = os.path.dirname(os.path.abspath(__file__))

LABELS = [
    ("lease", "Lease Deed"),
    ("fire", "Fire Safety Certificate"),
    ("structural", "Structural Stability Certificate"),
    ("occupancy_or_building", "Occupancy or Building Certificate"),
    ("nba_letter", "NBA Accreditation Letter"),
    ("audited_accounts", "Audited Accounts"),
    ("aicte_approval_letter", "AICTE Approval Letter"),
    ("other", "Other Document"),
]

FIRST = ["Aadhira","Bharat","Chandra","Devi","Eshwar","Gokul","Hari","Indira","Jayanti","Kaveri",
         "Lakshmi","Madhav","Narmada","Padma","Raghava","Saraswati","Tulsi","Uma","Vasanth","Yamuna",
         "Ananda","Bhavani","Dharani","Ezhil","Girija","Harsha","Ilango","Janaki","Kalyan","Mythili"]
LAST = ["Kumar","Sharma","Reddy","Iyer","Nair","Patel","Singh","Das","Rao","Menon","Gupta","Joshi","Pillai","Verma"]
CITY = ["Demopur","Sampleganj","Testnagar","Modelpet","Exampura","Northfield","Riverton","Hillcrest",
        "Lakeview","Greenvale","Stonebridge","Maplewood","Ashburn","Cedarpet","Fairhaven","Kingsmead"]
STATE = ["Tamil Nadu","Karnataka","Maharashtra","Gujarat","Rajasthan","Telangana","Kerala","Punjab",
         "Odisha","Uttar Pradesh","West Bengal","Madhya Pradesh"]
INST_TYPES = ["Institute of Technology","College of Engineering","Engineering College",
              "Institute of Engineering and Technology","Polytechnic College","School of Technology",
              "Institute of Management Studies"]
PROGS = ["Computer Science and Engineering","Electronics and Communication Engineering","Mechanical Engineering",
         "Civil Engineering","Electrical and Electronics Engineering","Information Technology",
         "Chemical Engineering","Artificial Intelligence and Data Science"]

SEPS = [": ", " : ", " - ", ":  ", " = ", " -- "]
DATE_FMTS = ["%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d %B %Y", "%d-%b-%Y", "%B %d, %Y"]
UPPERS = [True, False, True, False, True, False]
ORDERS = ["ff", "pf", "ff", "pf", "pf", "ff"]
NUMS = ["", "n", "a", "b", "d", "n"]

SYN = {
    "issue_date": ["Date of Issue", "Issued on", "Date of Issuance", "Issue Date", "Dated"],
    "valid_to": ["Valid up to", "Valid till", "Valid Until", "Date of Expiry", "Validity Upto"],
    "cert_no": ["Certificate No.", "Certificate Number", "Cert. No", "Ref. No.", "Serial No."],
    "authority": ["Issuing Authority", "Issued by", "Competent Authority", "Authority", "Issuing Office"],
    "address": ["Address", "Premises Address", "Location", "Situated at", "Site Address"],
    "inst": ["Institution", "Name of the Institution", "Applicant Institution", "Institute", "Name of College"],
}

# ---------------------------------------------------------------- helpers
def h(s): return int(hashlib.md5(s.encode()).hexdigest(), 16)

class Layout:
    def __init__(self, lid, split):
        self.id, self.split = lid, split
    def pick(self, name, pool):
        x, n = h(f"{self.id}:{name}"), len(pool)
        if self.split == "train":
            return pool[x % (n - 2)]          # train layouts never use the last 2 variants
        return pool[n - 2 + (x % 2)] if (x >> 8) % 2 == 0 else pool[x % n]
    def fd(self):
        fmt = self.pick("datefmt", DATE_FMTS)
        return lambda d: d.strftime(fmt)

def rand_date(r, y0, y1): return date(r.randint(y0, y1), r.randint(1, 12), r.randint(1, 28))
def add_years(d, n):
    try: return d.replace(year=d.year + n)
    except ValueError: return d.replace(year=d.year + n, day=28)
def inr(n):
    s = str(n)
    if len(s) <= 3: return s
    head, tail, parts = s[:-3], s[-3:], []
    while len(head) > 2: parts.insert(0, head[-2:]); head = head[:-2]
    if head: parts.insert(0, head)
    return ",".join(parts + [tail])
def person(r): return f"{r.choice(FIRST)} {r.choice(LAST)}"
def inst(r): return f"{r.choice(FIRST)} {r.choice(INST_TYPES)}"
def pin(r): return r.randint(100000, 999999)

def generic(r, iname, city, state):
    pool_t = [f"{iname}, {city}, {state} - {pin(r)}", f"Ref: {r.choice(['AC','ADM','GEN','OFF'])}/{r.randint(2015,2026)}/{r.randint(1,9999):04d}",
              "OFFICE COPY", "CERTIFIED TRUE COPY", "Scanned document"]
    pool_b = [f"Page 1 of {r.randint(1,5)}", "Authorised Signatory", "Seal and signature",
              "This is a computer generated document", f"Place: {city}"]
    return r.sample(pool_t, r.randint(0, 2)), r.sample(pool_b, r.randint(0, 2))

def build(L, r, title, fields, paras, top=(), bottom=()):
    sep, upper = L.pick("sep", SEPS), L.pick("upper", UPPERS)
    order, numst = L.pick("order", ORDERS), L.pick("num", NUMS)
    keep = [f for f in fields if r.random() > 0.12]
    if len(keep) < 3: keep = list(fields[:3])
    keep.sort(key=lambda f: hashlib.md5((L.id + f[0]).encode()).hexdigest())
    fl = []
    for i, (k, lab, val) in enumerate(keep):
        lab = L.pick("lbl:" + k, SYN[k]) if k in SYN else lab
        pre = {"": "", "n": f"{i+1}. ", "a": f"({chr(97+i)}) ", "b": "• ", "d": "- "}[numst]
        fl.append(f"{pre}{lab}{sep}{val}")
    if r.random() < 0.12: title = None            # simulates a lost header
    lines = list(top)
    if title: lines.append(title.upper() if upper else title)
    lines += (fl + list(paras)) if order == "ff" else (list(paras) + fl)
    lines += list(bottom)
    return "\n".join(lines)

# ---------------------------------------------------------------- classes
def gen_lease(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    start = rand_date(r, 2004, 2025); term = r.choice([5, 9, 10, 11, 15, 20, 25, 29, 30, 33, 50, 99])
    end = add_years(start, term) - timedelta(days=1); assert end > start
    words = {5:"five",9:"nine",10:"ten",11:"eleven",15:"fifteen",20:"twenty",25:"twenty five",29:"twenty nine",30:"thirty",33:"thirty three",50:"fifty",99:"ninety nine"}[term]
    lessor = r.choice([person(r), f"{r.choice(FIRST)} Educational Trust", f"{r.choice(FIRST)} Charitable Society", f"{r.choice(FIRST)} Foundation"])
    rent = r.randint(2, 90) * 50000
    c = dict(lessor=lessor, lessee=iname, city=city, state=state, start=fd(start), end=fd(end), term=term, words=words,
             rent=inr(rent), survey=f"{r.randint(1,999)}/{r.randint(1,9)}", acres=r.randint(2, 60), signed=fd(start - timedelta(days=r.randint(0, 20))))
    title = L.pick("title", ["Lease Deed","Deed of Lease","Land Lease Agreement","Registered Lease Deed","Lease Agreement for Educational Purpose","Indenture of Lease"])
    p1 = L.pick("p1", ["THIS LEASE DEED is made on {signed} between {lessor} (hereinafter called the Lessor) and {lessee} (hereinafter called the Lessee).",
        "This Deed of Lease is executed at {city} on {signed} by and between the Lessor, {lessor}, and the Lessee, {lessee}.",
        "AGREEMENT OF LEASE executed on {signed} at {city}. The Lessor {lessor} hereby leases the schedule property to the Lessee {lessee}.",
        "This Indenture made on {signed} witnesses that {lessor}, the Lessor, grants a lease of the land in Survey No. {survey} to {lessee}, the Lessee.",
        "On this day {signed} the Lessor {lessor} and the Lessee {lessee} have entered into this lease in respect of the land at {city}."]).format(**c)
    p2 = L.pick("p2", ["The Lessor demises the schedule property measuring {acres} acres in Survey No. {survey} for a term of {words} ({term}) years commencing from {start} and expiring on {end}.",
        "The lease shall commence on {start} and continue for {term} years, ending on {end}, unless terminated earlier as provided in this deed.",
        "TERM: The Lessee shall hold the land of {acres} acres at {city} for {term} years from {start} to {end}.",
        "The period of the lease is {words} years beginning {start}. The lease will expire on {end}.",
        "Duration of lease: {term} years. Lease start date {start}. Lease end date {end}."]).format(**c)
    p3 = L.pick("p3", ["The Lessee shall pay an annual rent of Rs. {rent} to the Lessor and shall use the premises only for educational purposes.",
        "Rent is fixed at Rs. {rent} per annum payable in advance. The Lessee shall not sublet the demised premises.",
        "The Lessee agrees to pay lease rent of Rs. {rent} every year and to maintain the buildings in good condition.",
        "The lease rent shall be Rs. {rent} per year, enhanced as per Schedule A. The land is to be used for running a technical institution.",
        "Annual rent Rs. {rent}. The lease may be renewed by mutual written consent. IN WITNESS WHEREOF the parties have signed."]).format(**c)
    fields = [("lessor", "Lessor", lessor), ("lessee", "Lessee", iname), ("reg", "Registration No", f"REG/{start.year}/{r.randint(100,99999)}"),
              ("sro", "Sub-Registrar Office", city), ("survey", "Survey No", c["survey"]), ("extent", "Extent of Land", f"{c['acres']} acres"),
              ("term", "Lease Term", f"{term} years"), ("from", "Lease Commencement Date", fd(start)), ("to", "Lease Expiry Date", fd(end)),
              ("stamp", "Stamp Duty Paid", f"Rs. {inr(r.randint(5, 400) * 1000)}")]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2, p3], top, bot)

def gen_fire(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    issue = rand_date(r, 2019, 2026); yrs = r.choice([1, 2, 3, 5]); valid = add_years(issue, yrs) - timedelta(days=1); assert valid > issue
    insp = issue - timedelta(days=r.randint(3, 25))
    c = dict(inst=iname, city=city, state=state, insp=fd(insp), yrs=yrs, floors=r.randint(2, 9), blocks=r.randint(1, 6))
    title = L.pick("title", ["Fire Safety Certificate","Fire No Objection Certificate","Fire Clearance Certificate","Certificate of Fire Safety Compliance","Fire NOC","Fire Safety Compliance Certificate"])
    p1 = L.pick("p1", ["This is to certify that the premises of {inst}, {city}, {state} were inspected on {insp} and found provided with fire prevention and fire fighting arrangements.",
        "The undersigned inspected the building of {inst} at {city} on {insp}. The fire safety measures installed are found satisfactory.",
        "Fire safety inspection of {inst} ({blocks} blocks, {floors} floors) was carried out on {insp}. The fire fighting installations were found in working condition.",
        "Certificate is issued to {inst}, {city} confirming that the fire fighting equipment and means of escape comply with the National Building Code fire safety provisions.",
        "NO OBJECTION is granted to {inst} at {city} from the fire safety point of view for use of the building as an educational institution."]).format(**c)
    p2 = L.pick("p2", ["Installed: portable fire extinguishers, hose reels, wet riser and yard hydrant, automatic sprinkler system and manual fire alarm system.",
        "The building has fire extinguishers on every floor, smoke detectors, fire alarm panel, two staircases and illuminated exit signs.",
        "Fire fighting systems such as hydrants, sprinklers, fire pump with underground water tank and emergency lighting have been verified.",
        "Fire exits, assembly points, refuge areas and fire fighting water storage were verified during inspection and found adequate.",
        "Fire alarm, extinguishers, hydrant lines and exit routes are maintained as per the prescribed norms."]).format(**c)
    p3 = L.pick("p3", ["This certificate is valid for {yrs} year(s) and must be renewed before the date of expiry. Any change in the building requires fresh inspection.",
        "The institution shall apply for renewal at least 60 days before the validity ends. The certificate stands cancelled if safety equipment is removed.",
        "This certificate is subject to annual maintenance of fire safety installations and is renewable on application.",
        "Renewal application must be made before expiry along with the fire audit report.",
        "The certificate does not relieve the owner of the responsibility to maintain fire safety at all times."]).format(**c)
    auth = r.choice(["Office of the District Fire Officer", "State Fire and Rescue Services", "Directorate of Fire Service", "Regional Fire Officer"]) + f", {city}"
    fields = [("cert_no", "", f"FS/{issue.year}/{r.randint(100,99999):05d}"), ("issue_date", "", fd(issue)), ("valid_to", "", fd(valid)),
              ("inst", "", iname), ("address", "", f"{r.randint(1,200)} {r.choice(['College Road','Temple Street','Station Road','Park Avenue'])}, {city}, {state}"),
              ("authority", "", auth), ("insp", "Date of Inspection", fd(insp))]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2, p3], top, bot)

def gen_structural(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    issue = rand_date(r, 2018, 2026); yrs = r.choice([3, 5, 10]); valid = add_years(issue, yrs) - timedelta(days=1); assert valid > issue
    eng = person(r); c = dict(inst=iname, city=city, eng=eng, floors=r.randint(2, 10), year=r.randint(1995, 2024), zone=r.choice(["II","III","IV"]), yrs=yrs,
                              found=r.choice(["isolated footings","raft foundation","pile foundation","combined footings"]), block=r.choice(["Main Academic Block","Workshop Block","Library Block","Hostel Block","Administrative Block"]))
    title = L.pick("title", ["Structural Stability Certificate","Structural Safety Certificate","Certificate of Structural Adequacy","Structural Soundness Certificate","Building Stability Certificate","Structural Engineer's Certificate"])
    p1 = L.pick("p1", ["I, {eng}, Licensed Structural Engineer, certify that I have inspected the {block} of {inst}, {city} and found the structure stable and safe for its intended use.",
        "This is to certify that the building of {inst} at {city} ({floors} storeys, built {year}) is structurally sound and safe for occupation as an educational building.",
        "On inspection of the structural elements of the {block}, {inst}, the columns, beams and slabs show no signs of distress and the building is structurally stable.",
        "The structural stability of the {block} of {inst} has been evaluated by {eng}. The structure is safe for the present loading.",
        "STRUCTURAL ADEQUACY of {inst}, {city}: the structure has been assessed and certified safe for continued use."]).format(**c)
    p2 = L.pick("p2", ["The structure rests on {found} and was designed for seismic zone {zone} as per IS 1893 and IS 456.",
        "Foundation type: {found}. The design considers dead load, live load, wind load and earthquake load for zone {zone}.",
        "Non destructive tests, rebound hammer and visual inspection were carried out. Foundation is {found}; seismic zone {zone}.",
        "The load bearing capacity of the frame was checked for seismic zone {zone}; the {floors} storey frame on {found} is adequate.",
        "No cracks, settlement or corrosion affecting stability were observed. Seismic zone {zone}."]).format(**c)
    p3 = L.pick("p3", ["This certificate is valid for {yrs} years from the date of issue unless structural changes are made.",
        "The certificate shall be revalidated after {yrs} years or after any major alteration or natural calamity.",
        "Validity {yrs} years. Any additional floor requires a fresh structural assessment.",
        "This certificate is issued on the basis of inspection and the drawings furnished by the institution.",
        "The engineer's responsibility is limited to the structural aspects assessed on the date of inspection."]).format(**c)
    fields = [("cert_no", "", f"SSC/{issue.year}/{r.randint(10,9999)}"), ("issue_date", "", fd(issue)), ("valid_to", "", fd(valid)), ("inst", "", iname),
              ("eng", "Structural Engineer", eng), ("lic", "Engineer Licence No", f"SE-{r.randint(1000,99999)}"), ("block", "Building", c["block"]),
              ("floors", "Number of Floors", str(c["floors"])), ("yr", "Year of Construction", str(c["year"]))]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2, p3], top, bot)

def gen_occupancy(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    issue = rand_date(r, 2005, 2026); comp = issue - timedelta(days=r.randint(20, 300))
    auth = r.choice(["Municipal Corporation", "Town Panchayat", "Urban Development Authority", "Planning Authority", "Municipal Council"]) + f", {city}"
    c = dict(inst=iname, city=city, auth=auth, plot=f"{r.randint(1,999)}/{r.choice('ABCD')}", area=inr(r.randint(2000, 90000)), floors=r.randint(1, 9),
             plan=f"BP/{r.randint(2005,2025)}/{r.randint(10,99999)}", comp=fd(comp), blocks=r.randint(1, 6))
    title = L.pick("title", ["Occupancy Certificate","Building Completion and Occupancy Certificate","Certificate of Occupancy","Building Completion Certificate","Building Plan Approval and Completion Certificate","Occupancy and Completion Certificate"])
    p1 = L.pick("p1", ["This is to certify that the building of {inst} at Plot No. {plot}, {city} has been completed as per the sanctioned plan No. {plan} and is fit for occupation.",
        "The construction of {blocks} block(s) of {inst} was inspected on {comp} and found to be in conformity with the approved building plan {plan}.",
        "Permission is granted to occupy the building constructed by {inst} at {city} for educational use, the work having been completed on {comp}.",
        "COMPLETION: {inst} has completed the construction of the educational building ({floors} floors, built-up area {area} sq ft) as per approved plan {plan}.",
        "The building at Plot {plot} belonging to {inst} is certified as completed and permitted for occupancy."]).format(**c)
    p2 = L.pick("p2", ["The built-up area is {area} sq ft with {floors} floors. Permitted use: educational institution.",
        "Use of the premises is restricted to educational purposes. Total built up area {area} square feet.",
        "The building has {floors} floors with a total built up area of {area} sq ft. Setbacks and parking are as sanctioned.",
        "No deviation from the sanctioned plan was noticed except minor permissible variations. Area {area} sq ft.",
        "Water supply, drainage, parking and access roads have been provided as per the sanction."]).format(**c)
    p3 = L.pick("p3", ["This certificate is issued by the {auth} under the local building bye-laws.",
        "Issued under the town planning rules by the {auth}. Any change of use requires fresh permission.",
        "The owner shall not make additions or alterations without sanction from the {auth}.",
        "This occupancy certificate does not confer title to the land.",
        "Issued subject to the conditions in the sanction order of the {auth}."]).format(**c)
    fields = [("cert_no", "", f"OC/{issue.year}/{r.randint(10,99999)}"), ("issue_date", "", fd(issue)), ("inst", "", iname), ("authority", "", auth),
              ("plot", "Plot No", c["plot"]), ("plan", "Sanctioned Plan No", c["plan"]), ("area", "Built-up Area", f"{c['area']} sq ft"),
              ("fl", "Number of Floors", str(c["floors"])), ("use", "Permitted Use", "Educational"), ("comp", "Date of Completion", fd(comp))]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2, p3], top, bot)

def gen_nba(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    issue = rand_date(r, 2018, 2026); yrs = r.choice([1, 2, 3, 5, 6]); end = add_years(issue, yrs) - timedelta(days=1); assert end > issue
    progs = r.sample(PROGS, r.randint(1, 4)); ay = f"{issue.year}-{str(issue.year + yrs)[-2:]}"
    c = dict(inst=iname, city=city, yrs=yrs, ay=ay, start=fd(issue), end=fd(end), plist="; ".join(progs))
    title = L.pick("title", ["Accreditation Letter","NBA Accreditation Letter","Grant of Accreditation","Letter of Accreditation Outcome","National Board of Accreditation - Accreditation Status","Intimation of Accreditation"])
    p1 = L.pick("p1", ["The National Board of Accreditation (NBA) is pleased to inform that the following programmes of {inst}, {city} have been accredited for a period of {yrs} year(s): {plist}.",
        "With reference to your application, the Executive Committee of NBA has decided to accredit the programmes {plist} of {inst} for {yrs} academic years.",
        "This is to inform {inst} that NBA has granted accreditation to {plist} from {start} to {end}.",
        "The Board has considered the evaluation report of {inst} and accredits the following programmes: {plist}. Period of accreditation {yrs} years.",
        "Accreditation of the undergraduate programmes ({plist}) of {inst} is granted by NBA for the period {start} to {end}."]).format(**c)
    p2 = L.pick("p2", ["The accreditation is effective from the academic year {ay} and valid till {end}.",
        "Period of accreditation: {start} to {end}. The institution shall display the accreditation status on its website.",
        "Validity of accreditation runs up to {end}. Application for continuation should be submitted well before expiry.",
        "The accredited status applies to the programmes listed above for the batches admitted during {ay}.",
        "Accreditation period: {yrs} years starting academic year {ay}."]).format(**c)
    p3 = L.pick("p3", ["The institution shall submit the annual self-assessment report and inform NBA of any change in faculty or intake.",
        "NBA reserves the right to withdraw accreditation if the conditions are not maintained. Programme outcomes must be documented.",
        "The institution is advised to strengthen outcome based education practices and the weaknesses noted in the report.",
        "This letter is issued by the Member Secretary on behalf of the Chairman, NBA.",
        "Accreditation does not imply approval by AICTE or any statutory body for intake."]).format(**c)
    fields = [("ref", "Reference No", f"NBA/ACC/{issue.year}/{r.randint(100,9999)}"), ("issue_date", "", fd(issue)), ("inst", "", iname),
              ("progs", "Programmes Accredited", "; ".join(progs)), ("from", "Accreditation From", fd(issue)), ("to", "Accreditation Valid Till", fd(end)),
              ("yrs", "Period of Accreditation", f"{yrs} years"), ("status", "Status", "Accredited")]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2, p3], top, bot)

def gen_accounts(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    y = r.randint(2016, 2025); rep = date(y + 1, r.randint(5, 12), r.randint(1, 28))
    firm = f"{r.choice(LAST)} and {r.choice(LAST)} Associates"; frn = f"{r.randint(100000,999999)}{r.choice('SNWE')}"
    inc = r.randint(40, 900) * 100000; exp = int(inc * r.uniform(0.7, 0.98)); sur = inc - exp; assets = r.randint(100, 3000) * 100000
    c = dict(inst=iname, fy=f"{y}-{y+1}", y1=y + 1, firm=firm, frn=frn, place=city, rep=fd(rep), inc=inr(inc), exp=inr(exp), sur=inr(sur), assets=inr(assets))
    title = L.pick("title", ["Audited Financial Statements","Independent Auditor's Report","Balance Sheet and Income and Expenditure Account","Audited Accounts","Annual Accounts and Auditor's Report","Statement of Accounts Audited"])
    p1 = L.pick("p1", ["We have audited the accompanying balance sheet of {inst} as at 31st March {y1} and the income and expenditure account for the year then ended.",
        "Report on the financial statements of {inst} for the financial year {fy}. The financial statements comprise the balance sheet and the income and expenditure account.",
        "In our opinion the financial statements give a true and fair view of the state of affairs of {inst} as at 31st March {y1} and of its surplus for the year ended.",
        "The management of {inst} is responsible for the preparation of these financial statements. Our responsibility is to express an opinion based on our audit.",
        "AUDITORS' REPORT to the Trustees of {inst} for the year ended 31 March {y1}."]).format(**c)
    p2 = L.pick("p2", ["We conducted our audit in accordance with the Standards on Auditing issued by the Institute of Chartered Accountants of India.",
        "Basis for opinion: the audit was planned and performed to obtain reasonable assurance that the financial statements are free of material misstatement.",
        "The books of account have been maintained and the balance sheet and income and expenditure account agree with the books.",
        "Total income Rs. {inc}, total expenditure Rs. {exp}, surplus for the year Rs. {sur}, total assets Rs. {assets}.",
        "Significant accounting policies and notes to accounts form part of these statements."]).format(**c)
    items = r.sample(["Corpus Fund", "General Fund", "Fixed Assets", "Current Liabilities", "Cash and Bank Balances", "Loans and Advances", "Fee Receivable", "Sundry Creditors", "Investments", "Depreciation Reserve"], 5)
    sched = [f"Schedule {i+1} - {n}  {inr(r.randint(5, 9000) * 10000)}" for i, n in enumerate(items)]
    p3 = L.pick("p3", ["For {firm}, Chartered Accountants, Firm Registration No. {frn}. Place: {place}. Date: {rep}.",
        "{firm}, Chartered Accountants (FRN {frn}), {place}, {rep}. UDIN generated for this report.",
        "Chartered Accountants {firm} FRN {frn}. Signed at {place} on {rep}.",
        "Audit completed at {place}; report dated {rep}; auditor {firm}.",
        "Auditor: {firm}. Membership and firm registration {frn}. Date of report {rep}."]).format(**c)
    fields = [("fy", "Financial Year", c["fy"]), ("firm", "Auditor", firm), ("frn", "Firm Registration No", frn),
              ("udin", "UDIN", f"{str(y+1)[-2:]}{r.randint(100000,999999)}{''.join(r.choice('ABCDEFGHJK') for _ in range(4))}{r.randint(1000,9999)}"),
              ("rep", "Date of Report", fd(rep)), ("inc", "Total Income", f"Rs. {c['inc']}"), ("exp", "Total Expenditure", f"Rs. {c['exp']}"),
              ("sur", "Surplus for the year", f"Rs. {c['sur']}")]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2] + sched + [p3], top, bot)

def gen_approval(L, r):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE)
    y = r.randint(2022, 2026); letter = date(y, r.randint(3, 9), r.randint(1, 28)); ay = f"{y}-{str(y+1)[-2:]}"
    progs = r.sample(PROGS, r.randint(2, 5)); lines = [f"{p} - {r.choice(['Undergraduate','Postgraduate','Diploma'])} - Approved Intake {r.choice([30,60,90,120,180])}" for p in progs]
    docs = r.sample(["a valid fire safety certificate", "the renewed lease deed", "a valid structural stability certificate", "the NBA accreditation letter", "the audited accounts for the last financial year"], 2)
    und = [f"The institution shall submit {d} on or before {fd(letter + timedelta(days=r.randint(30, 300)))}." for d in docs]
    ro = r.choice(["Southern", "Western", "Eastern", "Northern", "Central", "South Western", "North Eastern"]) + " Regional Office"
    c = dict(inst=iname, city=city, ay=ay, ro=ro, appno=f"1-{r.randint(10**9, 10**10 - 1)}")
    title = L.pick("title", ["Extension of Approval","Approval Letter","Extension of Approval for the Academic Year","Letter of Approval - Technical Institution","Grant of Extension of Approval","Approval of Technical Institution"])
    p1 = L.pick("p1", ["In exercise of the powers under the AICTE Act, Extension of Approval is granted to {inst}, {city} for the academic year {ay} as per Application No. {appno}.",
        "The All India Council for Technical Education hereby grants Extension of Approval to {inst} for the academic year {ay}, subject to the Approval Process Handbook.",
        "With reference to your application {appno}, approval of AICTE is conveyed to {inst} for the year {ay} for the courses and intake listed below.",
        "Based on the scrutiny of the application and documents uploaded on the AICTE portal, Extension of Approval for {ay} is granted to {inst}.",
        "AICTE approves the continuation of the technical programmes of {inst} for {ay} as detailed below."]).format(**c)
    p2 = L.pick("p2", ["The approval is subject to the undertakings below and compliance with the norms and standards of AICTE.",
        "This approval is conditional on the following undertakings and deficiencies being rectified within the stated time.",
        "The institution shall comply with the following conditions, failing which approval may be withdrawn.",
        "Approval is granted subject to fulfilment of the conditions stated:",
        "The Council may withdraw approval if the undertakings given are not honoured."]).format(**c)
    p3 = L.pick("p3", ["Issued by the {ro}, All India Council for Technical Education. Regional Officer.",
        "For the Council: Regional Officer, {ro}, AICTE. Copy to the Director of Technical Education.",
        "This letter is generated through the AICTE web portal. Signed by the {ro}.",
        "Member Secretary, AICTE, through the {ro}.",
        "Approval Bureau, AICTE. Issued via the {ro}."]).format(**c)
    fields = [("appno", "Application No", c["appno"]), ("file", "File No", f"F.No. {r.randint(1,99)}-{r.randint(1000,99999)}/{y}"), ("ay", "Academic Year", ay),
              ("issue_date", "", fd(letter)), ("inst", "", iname), ("ro", "Regional Office", ro)]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, fields, [p1, p2] + lines + und + [p3], top, bot)

# ---------------------------------------------------------------- other (20 subtypes; layout = subtype)
def gen_other(L, r, name):
    fd = L.fd(); iname = inst(r); city = r.choice(CITY); state = r.choice(STATE); d = rand_date(r, 2020, 2026); who = person(r)
    amt = r.randint(5, 900) * 1000; vend = f"{r.choice(FIRST)} {r.choice(['Traders','Enterprises','Supplies','Agencies'])}"
    gst = f"{r.randint(10,35)}{''.join(r.choice('ABCDEFGHJKLMNPQRSTUVWXYZ') for _ in range(5))}{r.randint(1000,9999)}A1Z{r.randint(1,9)}"
    items = lambda n: [f"{r.choice(['Laptop computers','Lab benches','Oscilloscopes','Printers','Projectors','Network switches','Chairs','Whiteboards'])} x {r.randint(2,60)}   Rs. {inr(r.randint(2,900)*1000)}" for _ in range(n)]
    T = {
     "invoice": ("Tax Invoice", [("n","Invoice No",f"INV/{d.year}/{r.randint(1,9999)}"),("d","Invoice Date",fd(d)),("v","Vendor",vend),("g","GSTIN",gst),("b","Bill To",iname),("t","Total Amount",f"Rs. {inr(amt)}")], items(3)+["Payment due within 30 days of invoice date. Goods once sold will not be taken back."]),
     "quotation": ("Quotation for Supply of Equipment", [("n","Quotation No",f"Q/{d.year}/{r.randint(1,999)}"),("d","Date",fd(d)),("v","From",vend),("t","To",iname)], items(3)+[f"Prices are valid for 30 days from {fd(d)}. Delivery within 4 weeks of order. Taxes extra."]),
     "purchase_order": ("Purchase Order", [("n","PO No",f"PO/{d.year}/{r.randint(1,9999)}"),("d","PO Date",fd(d)),("v","Supplier",vend),("t","Deliver To",f"{iname}, {city}")], items(3)+[f"Delivery required by {fd(d+timedelta(days=45))}. Payment within 30 days after receipt and inspection of the goods."]),
     "bank_statement": ("Account Statement", [("a","Account Holder",iname),("n","Account No",str(r.randint(10**10,10**11-1))),("p","Statement Period",f"{fd(d)} to {fd(d+timedelta(days=30))}"),("o","Opening Balance",f"Rs. {inr(amt)}")], [f"{fd(d+timedelta(days=i*3))}  {r.choice(['NEFT credit fees','Cheque debit','UPI transfer','Salary transfer','Interest credit'])}  Rs. {inr(r.randint(1,500)*1000)}" for i in range(6)]+["Closing balance carried forward. This is a statement of account, not a certificate."]),
     "salary_slip": ("Salary Slip", [("e","Employee Name",who),("g","Designation",r.choice(["Assistant Professor","Associate Professor","Lab Assistant","Office Superintendent"])),("m","Month",d.strftime("%B %Y")),("b","Basic Pay",f"Rs. {inr(r.randint(30,120)*1000)}"),("h","HRA",f"Rs. {inr(r.randint(5,30)*1000)}"),("n","Net Pay",f"Rs. {inr(r.randint(30,150)*1000)}")], ["Deductions include provident fund and professional tax. Computer generated payslip."]),
     "leave_application": ("Leave Application", [("t","To","The Principal"),("f","From",who),("s","Subject","Application for casual leave"),("d","Dates",f"{fd(d)} to {fd(d+timedelta(days=r.randint(1,4)))}")], [f"Respectfully I request you to grant me leave on the above dates due to {r.choice(['a family function','medical reasons','personal work'])}. Yours faithfully, {who}."]),
     "exam_timetable": ("End Semester Examination Timetable", [("s","Semester",str(r.randint(1,8))),("b","Branch",r.choice(PROGS)),("v","Venue",iname)], [f"{fd(d+timedelta(days=i))}  {r.choice(['Engineering Mathematics','Structural Analysis','Thermodynamics','Data Structures','Digital Electronics','Fire Dynamics Elective','Surveying'])}  10:00 AM to 1:00 PM" for i in range(5)]+["Candidates must carry hall tickets. Mobile phones are not allowed."]),
     "fire_drill_circular": ("Circular - Fire Safety Mock Drill", [("n","Circular No",f"CIR/{d.year}/{r.randint(1,300)}"),("d","Date",fd(d)),("t","To","All staff and students")], [f"A fire safety mock drill will be conducted on {fd(d+timedelta(days=7))} at 11:00 AM. All staff and students shall assemble at the ground. Fire extinguisher demonstration will be given.", "The fire safety certificate of the institution is displayed on the notice board for reference. Attendance is compulsory. Principal."]),
     "rent_receipt": ("Rent Receipt", [("n","Receipt No",str(r.randint(1,999))),("d","Date",fd(d)),("t","Received from",iname),("a","Amount",f"Rs. {inr(r.randint(10,200)*1000)}")], [f"Received monthly rent for the month of {d.strftime('%B %Y')} for the hostel building at {city} under the lease agreement dated {fd(d-timedelta(days=900))}. Received by {who}.", "Received in cash. This receipt only acknowledges payment of rent."]),
     "nba_workshop": ("Invitation - Workshop on Outcome Based Education", [("d","Date",fd(d)),("v","Venue",f"{iname}, {city}"),("f","Registration Fee",f"Rs. {r.randint(5,20)*100}")], ["You are invited to a two day workshop on outcome based education and preparation for NBA accreditation visits. Resource persons from industry and academia will address the participants.", "Registration closes one week before the workshop. Certificates will be given to participants."]),
     "audit_minutes": ("Minutes of Audit Committee Meeting", [("d","Date of Meeting",fd(d)),("p","Chairperson",who),("v","Venue",f"{iname}, {city}")], ["The committee reviewed the audited accounts for the previous financial year and noted the auditor's observations. The appointment of the statutory auditor for the next year was discussed.", f"Resolved that the audited accounts be placed before the governing body on {fd(d+timedelta(days=30))}. The meeting ended with a vote of thanks."]),
     "structures_question_paper": ("Structural Analysis - End Semester Examination", [("c","Course Code",f"CE{r.randint(300,499)}"),("m","Maximum Marks","100"),("t","Time","3 hours")], ["Q1. Determine the bending moment diagram for a propped cantilever beam carrying a uniformly distributed load. (20 marks)", "Q2. Analyse the stability of the portal frame and find the sway. (20 marks)", "Q3. Explain the factors affecting the stability of a structure and the role of a structural engineer. (10 marks)"]),
     "admission_notice": ("Admission Notice", [("c","Courses",r.choice(PROGS)),("l","Last Date to Apply",fd(d)),("f","Application Fee",f"Rs. {r.randint(3,10)*100}")], [f"Applications are invited for admission to B.E. programmes at {iname} for the coming academic year. Eligibility: pass in higher secondary examination with mathematics, physics and chemistry.", "Apply online through the institution website. Selected candidates will be intimated by email."]),
     "bonafide": ("Bonafide Certificate", [("n","Student Name",who),("r","Register No",f"{r.randint(10**9,10**10-1)}"),("c","Course",f"B.E. {r.choice(PROGS)}")], [f"This is to certify that the above student is a bonafide student of {iname} and is studying in the {r.randint(1,4)} year during the academic year {d.year}-{d.year+1}.", "This certificate is issued on request for bank loan purposes. Principal."]),
     "tender_notice": ("Tender Notice", [("n","Tender No",f"TN/{d.year}/{r.randint(1,200)}"),("w","Work","Construction of compound wall and drainage"),("e","EMD",f"Rs. {inr(r.randint(5,50)*1000)}"),("l","Last Date of Submission",fd(d))], [f"Sealed tenders are invited from registered contractors for the above work at {iname}, {city}. Tender documents can be obtained from the office on payment.", "The management reserves the right to reject any or all tenders without assigning reasons."]),
     "electricity_bill": ("Electricity Bill", [("c","Consumer No",str(r.randint(10**9,10**10-1))),("p","Billing Period",f"{fd(d)} to {fd(d+timedelta(days=60))}"),("u","Units Consumed",str(r.randint(500,40000))),("a","Amount Payable",f"Rs. {inr(r.randint(10,900)*1000)}"),("x","Due Date",fd(d+timedelta(days=75)))], ["Please pay before the due date to avoid disconnection and late fee. Bill issued by the electricity board section office."]),
     "marksheet": ("Statement of Marks", [("n","Name",who),("r","Register No",str(r.randint(10**9,10**10-1))),("s","Semester",str(r.randint(1,8)))], [f"{s}  Internal {r.randint(15,40)}  External {r.randint(25,60)}  Grade {r.choice(['O','A+','A','B+','B'])}" for s in r.sample(["Engineering Mathematics","Physics","Data Structures","Basic Electrical Engineering","Thermodynamics","Engineering Graphics"],5)]+["Result: PASS. Controller of Examinations."]),
     "sports_notice": ("Annual Sports Day Notice", [("d","Date",fd(d)),("v","Venue",f"{iname} Grounds"),("r","Registration",f"by {fd(d-timedelta(days=10))}")], ["Events include 100 m, relay, long jump, shot put, cricket and volleyball. Students may register with the physical director. Prizes will be distributed by the chief guest."]),
     "mess_bill": ("Hostel Mess Bill", [("n","Student Name",who),("m","Month",d.strftime("%B %Y")),("p","Per Day Charge",f"Rs. {r.randint(80,200)}"),("t","Total Payable",f"Rs. {inr(r.randint(2,6)*1000)}")], ["Mess charges are payable to the hostel warden by the 10th of every month. Absence days will be adjusted with prior intimation."]),
     "forwarding_letter": ("Forwarding Letter", [("n","Letter No",f"FL/{d.year}/{r.randint(1,500)}"),("d","Date",fd(d)),("t","To","The Regional Officer, AICTE"),("f","From",iname)], ["Sir, we are forwarding the following documents for your kind perusal: copy of the fire safety certificate, copy of the lease deed, structural stability certificate, NBA accreditation letter, audited accounts and the occupancy certificate.", f"Kindly acknowledge receipt. Yours faithfully, {who}, Principal."]),
     "doc_checklist": ("Document Checklist for Application", [("a","Institution",iname),("d","Checked on",fd(d)),("o","Checked by",who)], ["Fire safety certificate - received.", "Lease deed - received.", "Structural stability certificate - pending.", "NBA accreditation letter - not applicable.", "Audited accounts - received.", "Occupancy certificate - pending.", "AICTE approval letter - copy attached. This is only an internal checklist."]),
     "staff_meeting_minutes": ("Minutes of Staff Meeting", [("d","Date",fd(d)),("c","Chaired by",who),("a","Attendees",str(r.randint(10,80)))], ["Agenda 1: Academic calendar and internal assessment schedule. Agenda 2: Laboratory equipment requirements. Agenda 3: Industry visit arrangements.", "The Principal thanked all members. The meeting concluded at 4:30 PM."]),
    }
    title, fields, paras = T[name]
    top, bot = generic(r, iname, city, state)
    return build(L, r, title, [(k, lab, val) for k, lab, val in fields], paras, top, bot)

OTHER_NAMES = ["invoice","quotation","purchase_order","bank_statement","salary_slip","leave_application","exam_timetable",
    "fire_drill_circular","audit_minutes","structures_question_paper","admission_notice","staff_meeting_minutes",
    "sports_notice","forwarding_letter","nba_workshop","marksheet","mess_bill","rent_receipt","tender_notice","bonafide","electricity_bill","doc_checklist"]
OTHER_VAL = {"nba_workshop","marksheet","mess_bill"}
OTHER_TEST = {"rent_receipt","tender_notice","bonafide","electricity_bill","doc_checklist"}
GENS = {"lease":gen_lease,"fire":gen_fire,"structural":gen_structural,"occupancy_or_building":gen_occupancy,
        "nba_letter":gen_nba,"audited_accounts":gen_accounts,"aicte_approval_letter":gen_approval}

# ---------------------------------------------------------------- OCR-style noise
CONF = {'O':'0','0':'O','l':'1','1':'l','I':'l','S':'5','5':'S','B':'8','8':'B','e':'c','a':'o','n':'u','u':'n','Z':'2','G':'6'}
def noise(text, level, r):
    p = {"clean":0,"scanned":0.010,"skewed":0.018,"blurred":0.040}[level]
    if p == 0: return text
    lines = text.split("\n")
    if level in ("skewed", "blurred") and len(lines) > 6:
        keep = [l for l in lines if r.random() > 0.08]
        lines = keep if len(keep) >= 5 else lines
    out = []
    for ch in "\n".join(lines):
        x = r.random()
        if ch == "\n": out.append(ch)
        elif x < p * 0.5 and ch in CONF: out.append(CONF[ch])
        elif x < p * 0.7: continue
        elif x < p * 0.85: out.append(ch + r.choice(" .,'`|~"))
        elif x < p and ch == " ": continue
        else: out.append(ch)
    return "".join(out)

# ---------------------------------------------------------------- hardening
XREF = ["Annexure: a copy of the fire safety certificate is enclosed.", "Please refer to the lease deed registered earlier.",
        "The structural stability certificate has been submitted separately.", "NBA accreditation status is available on the institution website.",
        "Audited accounts for the last year are attached.", "The occupancy certificate is enclosed as proof.",
        "A copy of the AICTE approval letter is enclosed.", "Original documents will be produced on demand.",
        "Fire extinguishers were checked last month.", "The building plan was approved earlier."]
CUES = {"lease": r"lease|lessor|lessee|demise", "fire": r"fire", "structural": r"structur", "occupancy_or_building": r"occupan|completion|sanction",
        "nba_letter": r"accredit|nba|national board", "audited_accounts": r"audit|balance sheet|income and expenditure|chartered",
        "aicte_approval_letter": r"approval|aicte"}
import re as _re
def harden(slug, text, r):
    lines = text.split("\n")
    if r.random() < 0.35:                                   # cross-reference to another document type
        lines.insert(r.randint(0, len(lines)), r.choice(XREF))
    if r.random() < 0.18 and len(lines) >= 8:               # partial document (one page of several)
        n = len(lines); k = max(4, int(n * r.uniform(0.4, 0.7))); st = r.randint(0, n - k)
        part = lines[st:st + k]
        if slug == "other" or _re.search(CUES[slug], "\n".join(part), _re.I): lines = part
    return "\n".join(lines)

# ---------------------------------------------------------------- main
def split_for(slug, n, oname):
    if slug == "other": return "val" if oname in OTHER_VAL else "test" if oname in OTHER_TEST else "train"
    return "train" if n <= 8 else "val" if n <= 10 else "test"

def main():
    rows, seen = [], set()
    for slug, _ in LABELS:
        layouts = ([(f"other-L{i+1:02d}", split_for(slug, i+1, nm), nm) for i, nm in enumerate(OTHER_NAMES)] if slug == "other"
                   else [(f"{slug}-L{n:02d}", split_for(slug, n, None), None) for n in range(1, 13)])
        base, rem = divmod(PER_CLASS, len(layouts))
        for li, (lid, split, nm) in enumerate(layouts):
            per = base + (1 if li < rem else 0)
            L = Layout(lid, split)
            for k in range(per):
                for attempt in range(30):
                    r = random.Random(f"{SEED}:{lid}:{k}:{attempt}")
                    raw = gen_other(L, r, nm) if slug == "other" else GENS[slug](L, r)
                    raw = harden(slug, raw, r)
                    q = r.choices(["clean","scanned","skewed","blurred"], [0.40,0.30,0.15,0.15])[0]
                    text = "\n".join(l.strip() for l in noise(raw, q, r).split("\n") if l.strip())
                    key = hashlib.md5(text.encode()).hexdigest()
                    if key not in seen and len(text.split()) >= 15: seen.add(key); break
                else: raise RuntimeError(f"could not generate unique doc for {lid} #{k}")
                rows.append(dict(text=text, label=slug, layout_id=lid, quality=q, split=split, source="synthetic", n_words=len(text.split())))
    random.Random(SEED).shuffle(rows)
    for i, row in enumerate(rows): row["doc_id"] = f"M1-{i+1:06d}"
    cols = ["doc_id","text","label","layout_id","quality","split","source","n_words"]
    def write(name, subset):
        with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(subset)
    write("m1_documents_full.csv", rows)
    for s in ("train", "val", "test"): write(f"m1_{s}.csv", [x for x in rows if x["split"] == s])
    labels = {"model": "M1", "task": "document type classification", "classes": [{"id": s, "display_name": d} for s, d in LABELS],
              "confidence_zones": {"green": ">=0.90 pre-filled", "amber": "0.60-0.89 please check", "red": "<0.60 left blank"}}
    json.dump(labels, open(os.path.join(OUT, "labels.json"), "w"), indent=2)
    print("rows:", len(rows), dict(Counter(x["split"] for x in rows)))
    print("per class:", dict(Counter(x["label"] for x in rows)))
    print("quality:", dict(Counter(x["quality"] for x in rows)))

if __name__ == "__main__":
    main()
