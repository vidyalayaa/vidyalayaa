"""Render the deployment guide to a standalone, paginated PDF."""
from pathlib import Path
import re,html,textwrap,unicodedata
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,PageBreak,Preformatted,KeepTogether
from reportlab.lib.styles import getSampleStyleSheet,ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/'output/pdf/Vidyalayaa_Deployment_Guide.pdf'
OUTPUT.parent.mkdir(parents=True,exist_ok=True)
INK=colors.HexColor('#171b16');GREEN=colors.HexColor('#bce953');MUTED=colors.HexColor('#5a654f')
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='CoverEyebrow',fontName='Helvetica-Bold',fontSize=9,leading=14,textColor=MUTED,spaceAfter=25))
styles.add(ParagraphStyle(name='CoverTitle',fontName='Helvetica-Bold',fontSize=39,leading=44,textColor=INK,spaceAfter=22))
styles.add(ParagraphStyle(name='CoverSub',fontName='Helvetica',fontSize=17,leading=25,textColor=MUTED,spaceAfter=30))
styles.add(ParagraphStyle(name='SectionTitle',fontName='Helvetica-Bold',fontSize=17,leading=22,textColor=INK,spaceBefore=20,spaceAfter=12,keepWithNext=True))
styles.add(ParagraphStyle(name='BodyCopy',fontName='Helvetica',fontSize=9.5,leading=14,textColor=INK,spaceAfter=9,allowWidows=0,allowOrphans=0))
styles.add(ParagraphStyle(name='BulletCopy',parent=styles['BodyCopy'],leftIndent=12,firstLineIndent=-9))
styles.add(ParagraphStyle(name='CodeCopy',fontName='Courier-Bold',fontSize=8.1,leading=11,textColor=INK,backColor=colors.HexColor('#f1f5e9'),borderPadding=10,spaceBefore=7,spaceAfter=15))
styles.add(ParagraphStyle(name='NoteCopy',parent=styles['BodyCopy'],fontSize=9,textColor=MUTED))
def clean(s):return unicodedata.normalize('NFKC',s).replace('\u2014','-').replace('\u2013','-').replace('\u2019',"'").replace('\u2018',"'").replace('\u201c','"').replace('\u201d','"').replace('\u2264','<=').replace('\u2265','>=')
def inline(s):
 s=html.escape(clean(s));s=re.sub(r'`([^`]+)`',r'<font face="Courier" size="8.5">\1</font>',s);s=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',s);return s
story=[Spacer(1,80),Paragraph('VIDYALAYAA / ENGINEERING & OPERATIONS',styles['CoverEyebrow']),Paragraph('A connected school.<br/>A dependable release.',styles['CoverTitle']),Paragraph('Deployment &amp; operations guide',styles['CoverSub']),Paragraph('Version 1.2 | 19 October 2026<br/>Aligned with Software Architecture Specification v1.0',styles['NoteCopy']),Spacer(1,50),Paragraph('React web application. Express API. PostgreSQL authority.<br/>Independent background worker. NFC attendance services.',styles['BodyCopy']),Spacer(1,30),Paragraph('Includes environment setup, secrets, database initialization, authentication, hosting, migrations, testing, backups and troubleshooting. External credentials, remaining production firmware source and acceptance gates are identified explicitly.',styles['NoteCopy']),PageBreak()]
text=(ROOT/'docs/DEPLOYMENT.md').read_text(encoding='utf-8');lines=text.splitlines();paragraph=[];code=[];in_code=False
def flush():
 if paragraph:story.append(Paragraph(inline(' '.join(paragraph)),styles['BodyCopy']));paragraph.clear()
for line in lines:
 if line.startswith('```'):
  flush()
  if in_code:
   wrapped=[]
   for c in code:wrapped.extend(textwrap.wrap(clean(c),width=84,replace_whitespace=False,drop_whitespace=False,subsequent_indent='  ') or [''])
   story.append(Preformatted('\n'.join(wrapped),styles['CodeCopy']));code=[]
  in_code=not in_code;continue
 if in_code:code.append(line);continue
 if line.startswith('# '):continue
 if re.match(r'^Version \d+\.\d+ \|',line):continue
 if line.startswith('## '):flush();story.append(Paragraph(inline(line[3:]),styles['SectionTitle']));continue
 if not line.strip():flush();continue
 if line.startswith('- '):flush();story.append(Paragraph('- '+inline(line[2:]),styles['BulletCopy']));continue
 paragraph.append(line.strip())
flush()
def page(canvas,doc):
 canvas.saveState();w,h=A4
 if doc.page==1:
  canvas.setFillColor(GREEN);canvas.rect(0,h-18,w,18,fill=1,stroke=0);canvas.setFillColor(GREEN);canvas.roundRect(w-123,h-155,60,60,14,fill=1,stroke=0);canvas.setFillColor(INK);canvas.setFont('Helvetica-Bold',45);canvas.drawString(w-112,h-139,'v.')
 else:
  canvas.setStrokeColor(colors.HexColor('#dce3d1'));canvas.line(54,h-39,w-54,h-39);canvas.setFont('Helvetica-Bold',8);canvas.setFillColor(MUTED);canvas.drawString(54,h-29,'VIDYALAYAA');canvas.setFont('Helvetica',7);canvas.drawRightString(w-54,h-29,'DEPLOYMENT & OPERATIONS / v1.2')
 canvas.setFillColor(MUTED);canvas.setFont('Helvetica',7);canvas.drawString(54,29,'Internal engineering guide | Verify vendor and hardware gates before pilot');canvas.drawRightString(w-54,29,str(doc.page));canvas.restoreState()
SimpleDocTemplate(str(OUTPUT),pagesize=A4,rightMargin=54,leftMargin=54,topMargin=57,bottomMargin=51,title='Vidyalayaa Deployment and Operations Guide',author='Vidyalayaa Engineering').build(story,onFirstPage=page,onLaterPages=page)
print(OUTPUT)
