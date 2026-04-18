/**
 * api.js — Placement Dashboard Data Layer (Pure Supabase Edition)
 * ─────────────────────────────────────────────────────────────────────────────
 * All functions use the Supabase JS client (window._sb) from supabase-client.js.
 * Function names are identical to the old Flask version so all HTML pages work
 * without changes.
 *
 * Excel import/export is handled client-side using SheetJS (loaded via CDN).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Session Helpers ──────────────────────────────────────────────────────────
function getUser() {
    try { return JSON.parse(localStorage.getItem('pd_user') || 'null'); } catch { return null; }
}
function saveUser(user) { localStorage.setItem('pd_user', JSON.stringify(user)); }
function clearSession() {
    localStorage.removeItem('pd_user');
    localStorage.removeItem('pd_token');
}
function isLoggedIn() { return !!getUser(); }

// ─── REALTIME UPDATES ────────────────────────────────────────────────────────
function subscribeAllChanges(callback) {
    if (typeof _sb === 'undefined' || !_sb) {
        console.warn('[Realtime] Supabase client not initialized yet.');
        return null;
    }
    const channel = _sb.channel('pd-realtime-updates')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
            console.log(`[Realtime] ${payload.eventType} on ${payload.table}`);
            callback(payload);
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[Realtime] Subscribed to live database changes.');
            }
        });
    return channel;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function apiLogin(username, password) {
    const hash = await sha256(password);
    const { data, error } = await _sb.from('settings').select('*').limit(1).single();
    if (error) throw new Error('Cannot reach database. Check connection.');

    if (data.admin_username !== username) throw new Error('Invalid username or password.');
    if (data.admin_password_hash !== hash) throw new Error('Invalid username or password.');

    const user = {
        username: data.admin_username,
        email: data.admin_email,
        mobile: data.admin_mobile,
        role: 'admin',
        twoFaEnabled: data.two_factor_enabled
    };

    if (data.two_factor_enabled) {
        // 2FA flow: store pending user and redirect to MFA page
        localStorage.setItem('mfa_pending_user', JSON.stringify(user));
        return { requires_2fa: true };
    }

    // No 2FA — save session immediately
    saveUser(user);
    localStorage.setItem('pd_token', 'supabase_session_' + Date.now());
    return { success: true, user };
}

function apiLogout() {
    clearSession();
    window.location.href = 'index.html';
}

// MFA bypass for demo mode
async function skipMFA() {
    const pending = localStorage.getItem('mfa_pending_user');
    if (!pending) { window.location.href = 'index.html'; return; }
    const user = JSON.parse(pending);
    saveUser(user);
    localStorage.setItem('pd_token', 'supabase_session_' + Date.now());
    localStorage.removeItem('mfa_pending_user');
    window.location.href = 'dashboard.html';
}

async function apiVerifyOtp(userId, otp) {
    // For demo: accept any 6-digit OTP
    if (otp && otp.length >= 4) {
        const pending = localStorage.getItem('mfa_pending_user');
        if (!pending) throw new Error('No pending login session.');
        const user = JSON.parse(pending);
        saveUser(user);
        localStorage.setItem('pd_token', 'supabase_session_' + Date.now());
        localStorage.removeItem('mfa_pending_user');
        return { success: true, user };
    }
    throw new Error('Invalid OTP.');
}

// ─── HELPER: throw on Supabase error ─────────────────────────────────────────
function sbCheck(error, context) {
    if (error) throw new Error(`[${context}] ${error.message}`);
}

// ─── STUDENTS ─────────────────────────────────────────────────────────────────
async function getStudents() {
    let { data, error } = await _sb.from('students').select('*').order('student_name');
    sbCheck(error, 'getStudents');
    return data || [];
}

async function createStudent(payload) {
    // Accepts plain object or FormData
    const obj = payload instanceof FormData ? Object.fromEntries(payload.entries()) : payload;
    const { data, error } = await _sb.from('students').insert(obj).select().single();
    sbCheck(error, 'createStudent');
    return data;
}

async function updateStudent(id, payload) {
    const obj = payload instanceof FormData ? Object.fromEntries(payload.entries()) : payload;
    const { data, error } = await _sb.from('students').update(obj).eq('enrollment_number', id).select().single();
    sbCheck(error, 'updateStudent');
    return data;
}

async function deleteStudent(id) {
    const { error } = await _sb.from('students').delete().eq('enrollment_number', id);
    sbCheck(error, 'deleteStudent');
    return { success: true };
}

async function importStudents(fileOrFormData) {
    // Accepts a File object or FormData with a 'file' key
    const file = fileOrFormData instanceof File ? fileOrFormData
        : (fileOrFormData instanceof FormData ? fileOrFormData.get('file') : null);
    if (!file) throw new Error('No file provided for import.');
    const rows = await parseExcelFile(file, 'students');
    if (!rows.length) throw new Error('No valid rows found in file.');
    const { data, error } = await _sb.from('students').upsert(rows, { onConflict: 'enrollment_number' }).select();
    sbCheck(error, 'importStudents');
    return { imported: data.length, message: `Successfully imported ${data.length} students.` };
}

async function apiResetStudentPassword(enrollmentNumber, body) {
    // In the pure frontend version, student passwords are stored in their student record
    const { error } = await _sb.from('students')
        .update({ student_password: body.new_password })
        .eq('enrollment_number', enrollmentNumber);
    sbCheck(error, 'resetStudentPassword');
    return { message: 'Password reset successfully.' };
}

// ─── COMPANIES ────────────────────────────────────────────────────────────────
async function getCompanies() {
    let { data, error } = await _sb.from('companies').select('*').order('company_name');
    sbCheck(error, 'getCompanies');
    return data || [];
}

async function createCompany(payload) {
    const { data, error } = await _sb.from('companies').insert(payload).select().single();
    sbCheck(error, 'createCompany');
    return data;
}

async function updateCompany(id, payload) {
    const { data, error } = await _sb.from('companies').update(payload).eq('id', id).select().single();
    sbCheck(error, 'updateCompany');
    return data;
}

async function deleteCompany(id) {
    const { error } = await _sb.from('companies').delete().eq('id', id);
    sbCheck(error, 'deleteCompany');
    return { success: true };
}

async function importCompanies(fileOrFormData) {
    const file = fileOrFormData instanceof File ? fileOrFormData
        : (fileOrFormData instanceof FormData ? fileOrFormData.get('file') : null);
    if (!file) throw new Error('No file provided.');
    const rows = await parseExcelFile(file, 'companies');
    if (!rows.length) throw new Error('No valid rows found.');
    const { data, error } = await _sb.from('companies').upsert(rows, { onConflict: 'id' }).select();
    sbCheck(error, 'importCompanies');
    return { imported: data.length, message: `Imported ${data.length} companies.` };
}

// ─── PLACEMENTS ───────────────────────────────────────────────────────────────
async function getPlacements(prog = '') {
    try {
        let query = _sb.from('placements').select('*');
        if (prog) query = query.ilike('programme', `%${prog.trim()}%`);
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (e) {
        console.warn('[api] getPlacements filtered failed, fallback:', e);
        const { data, error } = await _sb.from('placements').select('*');
        if (error) { sbCheck(error, 'getPlacements'); return []; }
        if (!prog) return data || [];
        return (data || []).filter(p => (p.programme || '').toLowerCase().includes(prog.toLowerCase()));
    }
}

async function createPlacement(payload) {
    const { data, error } = await _sb.from('placements').insert(payload).select().single();
    sbCheck(error, 'createPlacement');
    return data;
}

async function updatePlacement(id, payload) {
    const { data, error } = await _sb.from('placements').update(payload).eq('id', id).select().single();
    sbCheck(error, 'updatePlacement');
    return data;
}

async function deletePlacement(id) {
    const { error } = await _sb.from('placements').delete().eq('id', id);
    sbCheck(error, 'deletePlacement');
    return { success: true };
}

/**
 * getAcademicYearPlacementRate()
 * ─────────────────────────────────────────────────────────────────────────────
 * Academic year runs July → June.
 * Cutoff rule:
 *   • Before September of the current year  → compute rate for the PREVIOUS
 *     academic year's batch (e.g. Apr 2026 → 2024-25 batch).
 *   • September or later                     → compute rate for the CURRENT
 *     academic year's batch (e.g. Oct 2026 → 2025-26 batch).
 *
 * Formula: (students from that batch who are placed / students from that batch
 *           who opted for placement) × 100
 *
 * Returns: { rate, placed, opted, batchLabel }
 */
async function getAcademicYearPlacementRate() {
    try {
        const now   = new Date();
        const month = now.getMonth() + 1; // 1-12
        const year  = now.getFullYear();

        // Determine the target academic year start/end
        let startYear, endYear;
        if (month < 9) {
            // Jan–Aug: previous academic year (passed out June of last year)
            startYear = year - 2;
            endYear   = year - 1;
        } else {
            // Sep–Dec: batch that just passed out in June of current year
            startYear = year - 1;
            endYear   = year;
        }

        const shortEnd   = String(endYear).slice(-2);         // "25"
        const batchLabel = `${startYear}-${shortEnd}`;        // "2024-25"

        // ── Fetch all students for efficiency ──────────────────────────────
        const { data: students, error: sErr } = await _sb
            .from('students')
            .select('enrollment_number, batch, admitted_year, opted_for_placement');
        if (sErr) { console.warn('[api] getAcademicYearPlacementRate - students fetch:', sErr); return null; }

        // Match students whose batch belongs to the target academic year.
        // Accepts formats: "2024-25", "24-25", "2025", "2024", "25", etc.
        const targetStudents = (students || []).filter(s => {
            const b = String(s.batch || s.admitted_year || '').trim();
            if (!b) return false;
            const bLow = b.toLowerCase();
            // Exact label match ("2024-25" / "24-25")
            if (bLow === batchLabel.toLowerCase()) return true;
            if (bLow === `${String(startYear).slice(-2)}-${shortEnd}`) return true;
            // Single-year graduation year match ("2025")
            if (b === String(endYear)) return true;
            // Single-year start year match ("2024")
            if (b === String(startYear)) return true;
            // Hyphenated match that contains the start year ("2024-...")
            if (b.startsWith(String(startYear) + '-')) return true;
            return false;
        });

        // Filter by opted_for_placement = Yes
        const optedStudents = targetStudents.filter(s => {
            const v = String(s.opted_for_placement || '').toLowerCase().trim();
            return v === 'yes' || v === '1' || v === 'true';
        });

        if (!optedStudents.length) {
            return { rate: 0, placed: 0, opted: 0, batchLabel };
        }

        // ── Fetch all placements (enrollment numbers only) ─────────────────
        const { data: placements, error: pErr } = await _sb
            .from('placements')
            .select('enrollment_number');
        if (pErr) { console.warn('[api] getAcademicYearPlacementRate - placements fetch:', pErr); return null; }

        const placedSet = new Set(
            (placements || []).map(p => String(p.enrollment_number).trim())
        );

        const placedCount = optedStudents.filter(
            s => placedSet.has(String(s.enrollment_number).trim())
        ).length;

        const rate = Math.round((placedCount / optedStudents.length) * 100);
        return { rate, placed: placedCount, opted: optedStudents.length, batchLabel };

    } catch (err) {
        console.error('[api] getAcademicYearPlacementRate error:', err);
        return null;
    }
}

async function importPlacements(fileOrFormData) {
    const file = fileOrFormData instanceof File ? fileOrFormData
        : (fileOrFormData instanceof FormData ? fileOrFormData.get('file') : null);
    if (!file) throw new Error('No file provided.');
    const rows = await parseExcelFile(file, 'placements');
    if (!rows.length) throw new Error('No valid rows found in file. Check that your Excel headers match: Enrolment No., Company Name, Date, Salary (LPA), Status');

    // Smart Replacement: Delete old placements for these students to prevent duplicates
    const enrollmentNumbers = [...new Set(rows.map(r => r.enrollment_number))];
    if (enrollmentNumbers.length > 0) {
        await _sb.from('placements').delete().in('enrollment_number', enrollmentNumbers);
    }

    const { data, error } = await _sb.from('placements').insert(rows).select();
    sbCheck(error, 'importPlacements');
    // Successfully imported. No longer updating local student placements_status flag.
    return { imported: (data || []).length, message: `Successfully imported ${(data || []).length} placement records.` };
}

// ─── INTERNSHIPS ──────────────────────────────────────────────────────────────
async function getInternships(prog = '') {
    try {
        let query = _sb.from('internships').select('*');
        if (prog) query = query.ilike('programme', `%${prog.trim()}%`);
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (e) {
        console.warn('[api] getInternships filtered failed, falling back to all then filter:', e);
        const { data, error } = await _sb.from('internships').select('*');
        if (error) { sbCheck(error, 'getInternships'); return []; }
        if (!prog) return data || [];
        return (data || []).filter(i => (i.programme || i.course || '').toLowerCase().includes(prog.toLowerCase()));
    }
}

async function createInternship(payload) {
    const { data, error } = await _sb.from('internships').insert(payload).select().single();
    sbCheck(error, 'createInternship');
    return data;
}

async function updateInternship(id, payload) {
    const { data, error } = await _sb.from('internships').update(payload).eq('id', id).select().single();
    sbCheck(error, 'updateInternship');
    return data;
}

async function deleteInternship(id) {
    const { error } = await _sb.from('internships').delete().eq('id', id);
    sbCheck(error, 'deleteInternship');
    return { success: true };
}

async function importInternships(fileOrFormData) {
    const file = fileOrFormData instanceof File ? fileOrFormData
        : (fileOrFormData instanceof FormData ? fileOrFormData.get('file') : null);
    if (!file) throw new Error('No file provided.');
    const rows = await parseExcelFile(file, 'internships');
    if (!rows.length) throw new Error('No valid rows found in file. Check that your Excel headers match: Year, Enrolment No., Programme, Gender, Internship Place, Internship Place 02, Type of Organization');

    // Smart Replacement: Delete old internships for these students
    const enrollmentNumbers = [...new Set(rows.map(r => r.enrollment_number))];
    if (enrollmentNumbers.length > 0) {
        await _sb.from('internships').delete().in('enrollment_number', enrollmentNumbers);
    }

    const { data, error } = await _sb.from('internships').insert(rows).select();
    sbCheck(error, 'importInternships');
    return { imported: (data || []).length, message: `Successfully imported ${(data || []).length} internship records.` };
}
// ─── FIELD VISITS ─────────────────────────────────────────────────────────────
async function getFieldVisits(program = '') {
    let query = _sb.from('field_visits').select('*');
    if (program) query = query.ilike('program_name', `%${program.trim()}%`);
    const { data, error } = await query;
    sbCheck(error, 'getFieldVisits');
    return data || [];
}

async function createFieldVisit(payload) {
    const { data, error } = await _sb.from('field_visits').insert(payload).select().single();
    sbCheck(error, 'createFieldVisit');
    return data;
}

async function updateFieldVisit(id, payload) {
    const { data, error } = await _sb.from('field_visits').update(payload).eq('id', id).select().single();
    sbCheck(error, 'updateFieldVisit');
    return data;
}

async function deleteFieldVisit(id) {
    const { error } = await _sb.from('field_visits').delete().eq('id', id);
    sbCheck(error, 'deleteFieldVisit');
    return { success: true };
}

async function importFieldVisits(fileOrFormData) {
    const file = fileOrFormData instanceof File ? fileOrFormData
        : (fileOrFormData instanceof FormData ? fileOrFormData.get('file') : null);
    if (!file) throw new Error('No file provided.');
    const rows = await parseExcelFile(file, 'field_visits');
    if (!rows.length) throw new Error('No valid rows found in file.');

    // For Field Visits, we insert all new rows (no specific student conflict)
    const { data, error } = await _sb.from('field_visits').insert(rows).select();
    sbCheck(error, 'importFieldVisits');
    return { imported: (data || []).length, message: `Successfully imported ${(data || []).length} field visit records.` };
}

// ─── INDUSTRIAL VISITS ────────────────────────────────────────────────────────
async function getIndustrialVisits(program = '') {
    let query = _sb.from('industrial_visits').select('*');
    if (program) query = query.ilike('program_name', `%${program.trim()}%`);
    const { data, error } = await query;
    sbCheck(error, 'getIndustrialVisits');
    return data || [];
}

async function createIndustrialVisit(payload) {
    const { data, error } = await _sb.from('industrial_visits').insert(payload).select().single();
    sbCheck(error, 'createIndustrialVisit');
    return data;
}

async function updateIndustrialVisit(id, payload) {
    const { data, error } = await _sb.from('industrial_visits').update(payload).eq('id', id).select().single();
    sbCheck(error, 'updateIndustrialVisit');
    return data;
}

async function deleteIndustrialVisit(id) {
    const { error } = await _sb.from('industrial_visits').delete().eq('id', id);
    sbCheck(error, 'deleteIndustrialVisit');
    return { success: true };
}

async function importIndustrialVisits(fileOrFormData) {
    const file = fileOrFormData instanceof File ? fileOrFormData
        : (fileOrFormData instanceof FormData ? fileOrFormData.get('file') : null);
    if (!file) throw new Error('No file provided.');
    const rows = await parseExcelFile(file, 'industrial_visits');
    if (!rows.length) throw new Error('No valid rows found in file.');
    const { data, error } = await _sb.from('industrial_visits').insert(rows).select();
    sbCheck(error, 'importIndustrialVisits');
    return { imported: (data || []).length, message: `Successfully imported ${(data || []).length} industrial visit records.` };
}

// ─── REPORTS (computed client-side from raw data) ─────────────────────────────
async function getStats(programme = '') {
    // Helper to build filtered count query
    const buildCount = (table, colHint = 'programme') => {
        let q = _sb.from(table).select('*', { count: 'exact', head: true });
        if (programme) {
            // Filter by the correct column name per table
            if (table === 'placements') q = q.ilike('programme', `%${programme.trim()}%`);
            else if (table === 'internships') q = q.ilike('programme', `%${programme.trim()}%`);
            else if (table === 'field_visits' || table === 'industrial_visits') q = q.ilike('program_name', `%${programme.trim()}%`);
            else q = q.ilike(colHint, `%${programme.trim()}%`);
        }
        return q.then(r => r.count || 0).catch(err => {
            console.warn(`[api] buildCount failed for ${table}:`, err);
            // Fallback: get total count if filtered one failed
            return _sb.from(table).select('*', { count: 'exact', head: true }).then(r => r.count || 0).catch(() => 0);
        });
    };

    const results = await Promise.allSettled([
        buildCount('students', 'programme'),
        buildCount('placements', 'course'),
        buildCount('companies', 'company_name'),
        buildCount('internships', 'programme'),
        buildCount('field_visits', 'program_name'),
        buildCount('industrial_visits', 'program_name'),
        buildCount('jobs', 'title')
    ]);

    const getValue = (idx) => results[idx].status === 'fulfilled' ? results[idx].value : 0;
    const total_students = getValue(0);
    const placed_students = getValue(1);

    // Fallback counts for total students based on activity if tables are empty
    let final_total_students = total_students;
    if (final_total_students === 0) {
        const [ps, is] = await Promise.all([getPlacements(programme), getInternships(programme)]);
        const uniqueIds = new Set([
            ...ps.map(x => x.enrollment_number || x.name || x.student_name),
            ...is.map(x => x.enrolment_no || x.name_of_student || x.student_name)
        ].filter(Boolean));
        final_total_students = uniqueIds.size;
    }

    return {
        total_students: final_total_students,
        placed_students,
        placement_rate: final_total_students ? Math.round((placed_students / final_total_students) * 100) : 0,
        total_companies: getValue(2),
        total_internships: getValue(3),
        total_field_visits: getValue(4),
        total_industrial_visits: getValue(5),
        total_visits: getValue(4) + getValue(5),
        total_external_jobs: getValue(6)
    };
}

async function getDeptStats(programme = '') {
    try {
        const [students, placements] = await Promise.all([
            getStudents().catch(() => []),
            getPlacements().catch(() => [])
        ]);

        const deptMap = {};
        const activePlacements = new Set(placements.map(p => String(p.enrollment_number).trim()));

        // 1. Map from Students
        students.forEach(s => {
            const d = s.programme || 'Unknown';
            if (programme && d !== programme) return;
            if (!deptMap[d]) deptMap[d] = { total: 0, placed: 0 };
            deptMap[d].total++;
            if (activePlacements.has(String(s.enrollment_number).trim())) {
                deptMap[d].placed++;
            }
        });

        // 2. Fallback: If we have placements for a course not in students table
        placements.forEach(p => {
            const d = p.programme || p.course || 'Other';
            if (programme && d !== programme) return;
            
            // If we already counted this student in step 1, skip.
            const isCounted = students.find(s => String(s.enrollment_number).trim() === String(p.enrollment_number).trim());
            if (isCounted) return;

            if (!deptMap[d]) deptMap[d] = { total: 0, placed: 0 };
            deptMap[d].placed++;
            if (deptMap[d].total < deptMap[d].placed) deptMap[d].total = deptMap[d].placed;
        });

        return Object.entries(deptMap).map(([dept, v]) => ({
            programme: dept,
            total: v.total,
            placed: v.placed
        }));
    } catch (e) {
        console.error('getDeptStats Error:', e);
        return [];
    }
}

async function getYearlyTrend(prog = '') {
    const placements = await getPlacements(prog);
    const yearMap = {};
    placements.forEach(p => {
        // Attempt to extract year from various date fields
        const dateStr = p.created_at || '';
        const yMatch = dateStr.match(/\b(20\d{2})\b/);
        const y = yMatch ? yMatch[1] : (dateStr.split('-')[0] || 'Unknown');
        yearMap[y] = (yearMap[y] || 0) + 1;
    });

    const sortedEntries = Object.entries(yearMap)
        .sort(([a], [b]) => a.localeCompare(b));

    return {
        labels: sortedEntries.map(([year]) => year),
        data: sortedEntries.map(([_, count]) => count)
    };
}

async function getStudentsYearly() {
    const [students, placements] = await Promise.all([
        getStudents().catch(() => []),
        getPlacements().catch(() => [])
    ]);
    const activePlacements = new Set(placements.map(p => String(p.enrollment_number).trim()));
    const yearMap = {};
    
    students.forEach(s => {
        // Safe year extraction
        const dateStr = s.created_at || '';
        const yMatch = dateStr.match(/\b(20\d{2})\b/);
        const y = yMatch ? yMatch[1] : (dateStr.split('-')[0] || 'Unknown');

        if (!yearMap[y]) yearMap[y] = { total: 0, placed: 0 };
        yearMap[y].total++;
        if (activePlacements.has(String(s.enrollment_number).trim())) {
            yearMap[y].placed++;
        }
    });

    const entries = Object.entries(yearMap).sort(([a], [b]) => a.localeCompare(b));
    return {
        labels: entries.map(([y]) => y),
        total: entries.map(([_, v]) => v.total),
        placed: entries.map(([_, v]) => v.placed)
    };
}

async function getSalaryDist() {
    const placements = await getPlacements();
    const ranges = {
        '0-3 LPA': 0,
        '3-6 LPA': 0,
        '6-10 LPA': 0,
        '10+ LPA': 0
    };

    const parseLPA = (s) => {
        if (!s) return 0;
        if (typeof s === 'number') return s;
        // Strip non-numeric except decimal point
        const clean = String(s).replace(/[^\d.]/g, '');
        const val = parseFloat(clean);
        // Handle "500,000" where it might be in rupees instead of LPA
        if (val > 1000) return val / 100000;
        return val;
    };

    placements.forEach(p => {
        const ctc = parseLPA(p.ctc || p.salary_lpa || 0);
        if (ctc > 0 && ctc <= 3) ranges['0-3 LPA']++;
        else if (ctc > 3 && ctc <= 6) ranges['3-6 LPA']++;
        else if (ctc > 6 && ctc <= 10) ranges['6-10 LPA']++;
        else if (ctc > 10) ranges['10+ LPA']++;
    });

    return Object.entries(ranges).map(([range, count]) => ({ range, count }));
}

// ─── ADMIN PROFILE ────────────────────────────────────────────────────────────
async function getAdminProfile() {
    const { data, error } = await _sb.from('settings').select('admin_username,admin_email,admin_mobile,two_factor_enabled').limit(1).single();
    sbCheck(error, 'getAdminProfile');
    return { username: data.admin_username, email: data.admin_email, mobile: data.admin_mobile, two_factor_enabled: data.two_factor_enabled };
}

async function updateAdminProfile(payload) {
    const updates = {};
    if (payload.email) updates.admin_email = payload.email;
    if (payload.mobile) updates.admin_mobile = payload.mobile;
    const { data, error } = await _sb.from('settings').update(updates).eq('id', 1).select().single();
    sbCheck(error, 'updateAdminProfile');
    const user = getUser() || {};
    if (payload.email) user.email = payload.email;
    if (payload.mobile) user.mobile = payload.mobile;
    saveUser(user);
    return data;
}

async function changeAdminPassword(payload) {
    const currentHash = await sha256(payload.current_password);
    const { data: settings, error: fetchErr } = await _sb.from('settings').select('admin_password_hash').limit(1).single();
    sbCheck(fetchErr, 'changeAdminPassword-fetch');
    if (settings.admin_password_hash !== currentHash) throw new Error('Current password is incorrect.');
    const newHash = await sha256(payload.new_password);
    const { error } = await _sb.from('settings').update({ admin_password_hash: newHash }).eq('id', 1);
    sbCheck(error, 'changeAdminPassword-update');
    return { message: 'Password changed successfully.' };
}

// ─── 2FA SETTINGS ─────────────────────────────────────────────────────────────
async function toggle2fa(enabled) {
    const { error } = await _sb.from('settings').update({ two_factor_enabled: enabled }).eq('id', 1);
    sbCheck(error, 'toggle2fa');
    return { enabled };
}

async function get2faStatus() {
    const { data, error } = await _sb.from('settings').select('two_factor_enabled').limit(1).single();
    sbCheck(error, 'get2faStatus');
    return { enabled: data.two_factor_enabled };
}

// ─── EXPORT TO EXCEL (client-side via SheetJS) ────────────────────────────────
async function exportData(type) {
    if (typeof XLSX === 'undefined') {
        alert('SheetJS library not loaded. Please check your internet connection.');
        return;
    }
    try {
        let rows = [];
        let sheetName = type;
        if (type === 'students') { rows = await getStudents(); sheetName = 'Students'; }
        else if (type === 'placements') { rows = await getPlacements(); sheetName = 'Placements'; }
        else if (type === 'companies') { rows = await getCompanies(); sheetName = 'Companies'; }
        else if (type === 'internships') { rows = await getInternships(); sheetName = 'Internships'; }
        else if (type === 'field_visits') { rows = await getFieldVisits(); sheetName = 'FieldVisits'; }
        else throw new Error(`Unknown export type: ${type}`);

        if (!rows || !rows.length) { alert('No data to export.'); return; }

        // Remove internal fields
        const cleaned = rows.map(r => {
            const obj = { ...r };
            delete obj.created_at;
            return obj;
        });

        const ws = XLSX.utils.json_to_sheet(cleaned);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        const filename = `${type}_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
        XLSX.writeFile(wb, filename);
    } catch (err) {
        alert('Export Error: ' + err.message);
    }
}

// ─── EXCEL PARSER (client-side via SheetJS) ───────────────────────────────────
async function parseExcelFile(file, type) {
    return new Promise((resolve, reject) => {
        if (typeof XLSX === 'undefined') {
            reject(new Error('SheetJS (xlsx) library not loaded.'));
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const wb = XLSX.read(e.target.result, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });

                let rows = [];
                // Helper: normalize keys
                const normalizeRow = (r) => {
                    const nr = {};
                    for (const key in r) {
                        if (r.hasOwnProperty(key)) {
                            nr[key.trim().toLowerCase()] = r[key];
                        }
                    }
                    return nr;
                };

                // Helper: get first matching value from a normalized row using lowercase keys
                function col(nr, ...keys) {
                    for (let k of keys) {
                        k = k.trim().toLowerCase();
                        if (nr[k] !== undefined && nr[k] !== '') {
                            let val = nr[k];
                            // Handle scientific notation for large numbers (like Enrolment No.)
                            if (typeof val === 'number') {
                                // If it's a very large number (likely an ID), prevent scientific notation
                                if (val > 1000000) {
                                    return val.toLocaleString('fullwide', { useGrouping: false });
                                }
                                return String(val).trim();
                            }
                            return String(val).trim();
                        }
                    }
                    return '';
                }

                if (type === 'students') {
                    rows = raw.map(r => {
                        const nr = normalizeRow(r);
                        return {
                            admitted_year: col(nr, 'Admitted_Year', 'Admitted Year', 'admitted_year'),
                            student_name: col(nr, 'Name_of_the_Student', 'Student_Name', 'Student Name', 'Name', 'student_name'),
                            enrollment_number: col(nr, 'Enrollment_No', 'Enrollment No', 'Enrollment Number', 'Enrolment Number', 'enrollment_number'),
                            programme: col(nr, 'Program', 'Programme', 'programme'),
                            batch: col(nr, 'Batch', 'batch'),
                            student_email_id: col(nr, 'RRU_Email_id', 'Email ID', 'Email Id', 'Email', 'student_email_id'),
                            personal_email_id: col(nr, 'Personal_email_id', 'personal_email_id'),
                            mobile_number: col(nr, 'Phone_number', 'Mobile Number', 'Mobile', 'Phone', 'mobile_number'),
                            remark: col(nr, 'Remark', 'remark'),
                            opted_for_placement: col(nr, 'Opted for Placement', 'OPTED FOR PLACEMENT?', 'opted_for_placement') || 'No',

                        };
                    }).filter(r => r.enrollment_number && r.student_name);

                } else if (type === 'companies') {
                    rows = raw.map(r => {
                        const nr = normalizeRow(r);
                        return {
                            company_name: col(nr, 'Company Name', 'Company', 'company_name'),
                            role: col(nr, 'Role', 'role'),
                            contact_person: col(nr, 'Contact Person', 'Contact Name', 'contact_person'),
                            contact: col(nr, 'Contact', 'Phone', 'Mobile', 'contact'),
                        };
                    }).filter(r => r.company_name);

                } else if (type === 'placements') {
                    rows = raw.map(r => {
                        const nr = normalizeRow(r);
                        return {
                            enrollment_number: col(nr, 'Enrollment_No', 'Enrollment No', 'Enrollment Number', 'Enrolment Number', 'enrollment_number', 'Enrollement No.'),
                            programme: col(nr, 'Programme', 'Course', 'programme', 'course', 'program'),
                            batch: col(nr, 'Batch', 'batch'),
                            name: col(nr, 'Name', 'Student Name', 'name', 'student_name'),
                            role: col(nr, 'Role', 'remarks', 'role'),
                            company: col(nr, 'Company', 'company', 'organization_name'),
                            city: col(nr, 'City', 'city'),
                            salary: col(nr, 'Salary', 'ctc', 'package', 'salary')
                        };
                    }).filter(r => r.enrollment_number);

                } else if (type === 'internships') {
                    rows = raw.map(r => {
                        const nr = normalizeRow(r);
                        return {
                            enrollment_number: col(nr, 'Enrollment_No', 'Enrolment No.', 'Enrollment No', 'Enrollment Number', 'Enrolment Number', 'enrollment_number', 'Enrollement No.'),
                            year: col(nr, 'Year', 'year'),
                            programme: col(nr, 'Programme', 'Program', 'programme'),
                            name_of_student: col(nr, 'Name of Student', 'Student Name', 'Name', 'student_name', 'name_of_student'),
                            gender: col(nr, 'Gender', 'gender'),
                            role: col(nr, 'Role', 'role', 'internship_role'),
                            salary: col(nr, 'Salary', 'salary', 'stipend'),
                            internship_place_01: col(nr, 'Internship Place', 'internship_place', 'Internship Place 01', 'organization'),
                            duration_of_intership_01: col(nr, 'Duration', 'duration', 'duration_of_intership', 'Duration 01'),
                            city_of_intership_01: col(nr, 'City', 'Internship City', 'city', 'city_of_intership', 'City 01'),
                            type_of_organization: col(nr, 'Type of Organization', 'Organization Type', 'organization_type', 'type_of_organization')
                        };
                    }).filter(r => r.enrollment_number);
                } else if (type === 'field_visits') {
                    rows = raw.map(r => {
                        const nr = normalizeRow(r);
                        return {
                            field_visited: col(nr, 'Field_Visited', 'Department', 'Dept', 'Dept.', 'organization_name', 'field_visited'),
                            visited_date: col(nr, 'Visited_Date', 'Date', 'Visit Date', 'visit_date'),
                            visit_type: col(nr, 'Visit Type', 'Type', 'type', 'visit_type') || 'Government',
                            no_of_student_visited: parseInt(col(nr, 'No_of_Student_Visited', 'No of Students', 'No of Student Visited', 'Students', 'students_visited') || 0),
                            program_name: col(nr, 'Program_Name', 'Programme', 'programme', 'program'),
                            no_of_staff_visited: parseInt(col(nr, 'No_of_Staff_Visited', 'No of Staff', 'No of Staff Visited', 'Staff', 'staff_visited') || 0),
                            staff_name: col(nr, 'Staff_Name', 'Faculty Coordinator', 'Faculty', 'Coordinator', 'staff_name', 'faculty'),
                            city: col(nr, 'City', 'Location', 'Place', 'city')
                        };
                    }).filter(r => r.field_visited && r.visited_date);
                } else if (type === 'industrial_visits') {
                    rows = raw.map(r => {
                        const nr = normalizeRow(r);
                        return {
                            organization_name: col(nr, 'Organization_Visited', 'Organization Name', 'Organization', 'organization_name', 'field_visited'),
                            visited_date: col(nr, 'Visited_Date', 'Date', 'Visit Date', 'visit_date'),
                            visit_type: col(nr, 'Visit Type', 'Type', 'type', 'visit_type') || 'Private',
                            no_of_student_visited: parseInt(col(nr, 'No_of_Student_Visited', 'No of Students', 'No of Student Visited', 'Students', 'students_visited') || 0),
                            program_name: col(nr, 'Program_Name', 'Programme', 'programme', 'program'),
                            no_of_staff_visited: parseInt(col(nr, 'No_of_Staff_Visited', 'No of Staff', 'No of Staff Visited', 'Staff', 'staff_visited') || 0),
                            staff_name: col(nr, 'Staff_Name', 'Faculty Coordinator', 'Faculty', 'Coordinator', 'staff_name', 'faculty'),
                            city: col(nr, 'City', 'Location', 'Place', 'city')
                        };
                    }).filter(r => r.organization_name && r.visited_date);
                }
                resolve(rows);
            } catch (err) {
                reject(new Error('Failed to parse Excel file: ' + err.message));
            }
        };
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsArrayBuffer(file);
    });
}

// ─── LOAD ADMIN PROFILE IN SETTINGS ──────────────────────────────────────────
async function loadAdminProfileData() {
    try {
        const profile = await getAdminProfile();
        const emailEl = document.getElementById('email');
        const phoneEl = document.getElementById('phone');
        const usernameEl = document.getElementById('username') || document.getElementById('adminUsername');
        if (emailEl) emailEl.value = profile.email || '';
        if (phoneEl) phoneEl.value = profile.mobile || '';
        if (usernameEl) usernameEl.value = profile.username || 'admin';
        // Populate sidebar
        const user = getUser() || {};
        user.email = profile.email;
        user.mobile = profile.mobile;
        saveUser(user);
    } catch (e) {
        console.error('Failed to load admin profile', e);
    }
}
