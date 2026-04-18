
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://rnuuhgiqymukzojiflry.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJudXVoZ2lxeW11a3pvamlmbHJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDEzMDUsImV4cCI6MjA5MDUxNzMwNX0.IeKHzPrc4Hlz5_jjHUfy_crdavE38sI-IRkwuO9ES84';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function inspect() {
    const { data, error } = await supabase.from('field_visits').select('*').limit(1);
    if (error) {
        console.error('Error:', error);
        return;
    }
    if (data && data.length > 0) {
        console.log('Columns:', Object.keys(data[0]));
    } else {
        console.log('No data in field_visits');
    }
}

inspect();
