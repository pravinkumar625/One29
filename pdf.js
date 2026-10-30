const PDFDocument = require('pdfkit');

// Strip or replace non-latin characters that standard Type 1 fonts (Helvetica) cannot render
function sanitizeForFont(str) {
  if (!str) return '';
  return String(str)
    // Replace smart quotes and dashes with standard ASCII
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2022\u2023\u25E6\u2043\u2219]/g, '•')
    .replace(/\u2026/g, '...')
    // Replace non-ascii characters outside Latin-1 supplement with '?' or closest ascii
    .normalize('NFKD')
    .replace(/[^\x00-\xFF]/g, '');
}

const THEME_ACCENTS = [
  '#C89B00', // Butter (darkened for readable print contrast)
  '#2D5BFF', // Cobalt
  '#E03E19', // Flame
  '#1F2937', // Night
  '#5C8C00', // Acid (darkened green for print contrast)
  '#D93B88', // Bubblegum
];

function generateResumePdf(user, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const template = (options.template || 'classic').toLowerCase();
      const themeIdx = Number.isInteger(user.theme) && user.theme >= 0 && user.theme <= 5 ? user.theme : 0;
      
      let primaryColor = '#111827';
      let accentColor = '#374151';
      let ruleColor = '#E5E7EB';
      let lightBg = '#F3F4F6';

      if (template === 'modern') {
        accentColor = THEME_ACCENTS[themeIdx] || '#2D5BFF';
      } else if (template === 'minimal') {
        primaryColor = '#18181B';
        accentColor = '#52525B';
        ruleColor = '#E4E4E7';
      } else {
        // Classic
        primaryColor = '#0F172A';
        accentColor = '#1E3A8A'; // Deep Navy
        ruleColor = '#CBD5E1';
      }

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 45, right: 45 },
        bufferPages: true,
        autoFirstPage: true,
        info: {
          Title: `${user.name || 'Student'} - Resume`,
          Author: user.name || 'Student',
          Creator: 'Class of ’29 Portfolio Platform',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const links = typeof user.links === 'object' && user.links !== null ? user.links : {};
      const skills = Array.isArray(user.skills) ? user.skills : [];
      const projects = Array.isArray(user.projects) ? user.projects : [];
      const experience = Array.isArray(user.experience) ? user.experience : [];
      const education = Array.isArray(user.education) ? user.education : [];
      const certifications = Array.isArray(user.certifications) ? user.certifications : [];
      const achievements = Array.isArray(user.achievements) ? user.achievements : [];

      const cleanText = (t) => sanitizeForFont(t);

      // --- 1. HEADER (Name, Role) ---
      doc.font('Helvetica-Bold')
        .fontSize(22)
        .fillColor(primaryColor)
        .text(cleanText(user.name || 'Student'), { align: template === 'classic' ? 'center' : 'left' });

      if (user.role) {
        doc.font('Helvetica-Bold')
          .fontSize(11)
          .fillColor(accentColor)
          .moveDown(0.2)
          .text(cleanText(user.role.toUpperCase()), { align: template === 'classic' ? 'center' : 'left' });
      }

      // --- Contact Line ---
      // Links email only (never google email!), phone, location, github, linkedin, website
      const contactItems = [];
      if (links.email) contactItems.push(cleanText(links.email));
      if (user.phone) contactItems.push(cleanText(user.phone));
      if (user.location) contactItems.push(cleanText(user.location));
      if (links.github) contactItems.push(cleanText(links.github.replace(/^https?:\/\//i, '')));
      if (links.linkedin) contactItems.push(cleanText(links.linkedin.replace(/^https?:\/\//i, '')));
      if (links.website) contactItems.push(cleanText(links.website.replace(/^https?:\/\//i, '')));

      if (contactItems.length > 0) {
        doc.font('Helvetica')
          .fontSize(9)
          .fillColor('#4B5563')
          .moveDown(0.3)
          .text(contactItems.join('  •  '), { align: template === 'classic' ? 'center' : 'left' });
      }

      doc.moveDown(0.8);

      // Section divider helper
      function addSectionHeader(title) {
        doc.moveDown(0.6);
        const y = doc.y;
        
        if (template === 'minimal') {
          doc.font('Helvetica-Bold')
            .fontSize(10)
            .fillColor(accentColor)
            .text(title.toUpperCase(), { characterSpacing: 1 });
          doc.moveTo(doc.page.margins.left, doc.y + 2)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
            .strokeColor(ruleColor)
            .lineWidth(0.5)
            .stroke();
          doc.moveDown(0.4);
        } else if (template === 'modern') {
          doc.font('Helvetica-Bold')
            .fontSize(10.5)
            .fillColor(accentColor)
            .text(title.toUpperCase(), { characterSpacing: 0.8 });
          doc.moveTo(doc.page.margins.left, doc.y + 2)
            .lineTo(doc.page.margins.left + 50, doc.y + 2)
            .strokeColor(accentColor)
            .lineWidth(2)
            .stroke();
          doc.moveTo(doc.page.margins.left + 52, doc.y + 2)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
            .strokeColor(ruleColor)
            .lineWidth(0.5)
            .stroke();
          doc.moveDown(0.4);
        } else {
          // Classic
          doc.font('Helvetica-Bold')
            .fontSize(11)
            .fillColor(accentColor)
            .text(title.toUpperCase());
          doc.moveTo(doc.page.margins.left, doc.y + 2)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
            .strokeColor(accentColor)
            .lineWidth(1)
            .stroke();
          doc.moveDown(0.4);
        }
      }

      // --- 2. SUMMARY (Bio) ---
      if (user.bio) {
        addSectionHeader('Professional Summary');
        doc.font('Helvetica')
          .fontSize(9.5)
          .fillColor('#374151')
          .text(cleanText(user.bio), {
            lineGap: 2.5,
            align: 'justify',
          });
      }

      // --- 3. SKILLS ---
      if (skills.length > 0) {
        addSectionHeader('Technical Skills');
        doc.font('Helvetica')
          .fontSize(9.5)
          .fillColor('#374151')
          .text(skills.map(cleanText).join('  •  '), { lineGap: 2 });
      }

      // --- 4. PROJECTS ---
      if (projects.length > 0) {
        addSectionHeader('Key Projects');
        projects.forEach((p, idx) => {
          if (!p.title) return;
          if (idx > 0) doc.moveDown(0.4);
          
          doc.font('Helvetica-Bold')
            .fontSize(9.5)
            .fillColor(primaryColor)
            .text(cleanText(p.title), { continued: Boolean(p.url) });
          
          if (p.url) {
            doc.font('Helvetica')
              .fontSize(8.5)
              .fillColor(accentColor)
              .text(`  (${cleanText(p.url)})`);
          }

          if (p.desc) {
            doc.font('Helvetica')
              .fontSize(9)
              .fillColor('#4B5563')
              .moveDown(0.15)
              .text(cleanText(p.desc), { lineGap: 1.5 });
          }
        });
      }

      // --- 5. EXPERIENCE ---
      if (experience.length > 0) {
        addSectionHeader('Experience');
        experience.forEach((exp, idx) => {
          if (!exp.title && !exp.organisation) return;
          if (idx > 0) doc.moveDown(0.4);

          const leftText = [exp.title, exp.organisation].filter(Boolean).map(cleanText).join(' — ');
          const dateText = [exp.start, exp.end].filter(Boolean).map(cleanText).join(' – ');

          const startY = doc.y;
          doc.font('Helvetica-Bold')
            .fontSize(9.5)
            .fillColor(primaryColor)
            .text(leftText, { width: 360 });

          if (dateText) {
            const dateWidth = 140;
            const rightX = doc.page.width - doc.page.margins.right - dateWidth;
            doc.font('Helvetica-Bold')
              .fontSize(8.5)
              .fillColor('#6B7280')
              .text(dateText, rightX, startY, { width: dateWidth, align: 'right' });
          }

          if (exp.description) {
            doc.font('Helvetica')
              .fontSize(9)
              .fillColor('#4B5563')
              .moveDown(0.15)
              .text(cleanText(exp.description), { lineGap: 1.5 });
          }
        });
      }

      // --- 6. EDUCATION ---
      if (education.length > 0) {
        addSectionHeader('Education');
        education.forEach((edu, idx) => {
          if (!edu.school && !edu.degree) return;
          if (idx > 0) doc.moveDown(0.4);

          const degreeLine = [edu.degree, edu.field].filter(Boolean).map(cleanText).join(' in ');
          const headerLine = [degreeLine, edu.school].filter(Boolean).map(cleanText).join(' — ');
          const dateText = [edu.start_year, edu.end_year].filter(Boolean).map(cleanText).join(' – ');

          const startY = doc.y;
          doc.font('Helvetica-Bold')
            .fontSize(9.5)
            .fillColor(primaryColor)
            .text(headerLine || cleanText(edu.school || ''), { width: 360 });

          if (dateText) {
            const dateWidth = 140;
            const rightX = doc.page.width - doc.page.margins.right - dateWidth;
            doc.font('Helvetica-Bold')
              .fontSize(8.5)
              .fillColor('#6B7280')
              .text(dateText, rightX, startY, { width: dateWidth, align: 'right' });
          }
        });
      }

      // --- 7. CERTIFICATIONS ---
      if (certifications.length > 0) {
        addSectionHeader('Certifications');
        certifications.forEach((c) => {
          if (!c.name) return;
          const text = [c.name, c.issuer, c.year].filter(Boolean).map(cleanText).join(' • ');
          doc.font('Helvetica')
            .fontSize(9)
            .fillColor('#374151')
            .text(`•  ${text}`, { lineGap: 1.5 });
        });
      }

      // --- 8. ACHIEVEMENTS ---
      if (achievements.length > 0) {
        addSectionHeader('Achievements & Honors');
        achievements.forEach((ach) => {
          if (!ach) return;
          doc.font('Helvetica')
            .fontSize(9)
            .fillColor('#374151')
            .text(`•  ${cleanText(ach)}`, { lineGap: 1.5 });
        });
      }

      // --- FOOTER ON EACH PAGE ---
      const hostUrl = options.baseUrl || 'https://classof29.kalvium.community';
      const profileUrl = `${hostUrl}/#/u/${user.username}`;
      const nowFormatted = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      const footerText = cleanText(`Generated from my portfolio on ${nowFormatted} · ${profileUrl}`);

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica')
          .fontSize(7.5)
          .fillColor('#9CA3AF')
          .text(
            footerText,
            doc.page.margins.left,
            doc.page.height - doc.page.margins.bottom + 15,
            {
              width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
              align: 'center',
            }
          );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateResumePdf,
  sanitizeForFont,
};
