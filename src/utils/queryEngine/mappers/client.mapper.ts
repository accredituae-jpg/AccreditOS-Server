export interface ClientDTO {
  id: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  fax: string | null;
  email: string;
  trnNo: string;
  poBox: string;
  location: string;
  status: string;
  notes: string | null;
  courseRates?: any;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientOptionDTO {
  id: string;
  label: string;
  companyName: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  trnNo?: string;
  poBox?: string;
  location?: string;
  courseRates?: any;
  meta: {
    companyName: string;
    trnNo?: string;
    location?: string;
  };
}

export function mapClientToDTO(raw: any): ClientDTO {
  return {
    id: raw.id,
    companyName: raw.companyName,
    contactPerson: raw.contactPerson,
    phone: raw.phone,
    fax: raw.fax ?? null,
    email: raw.email,
    trnNo: raw.trnNo || "",
    poBox: raw.poBox || "",
    location: raw.location,
    status: raw.status,
    notes: raw.notes ?? null,
    courseRates: raw.courseRates ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export function mapClientToOptionDTO(raw: any): ClientOptionDTO {
  return {
    id: raw.id,
    label: raw.companyName,
    companyName: raw.companyName,
    contactPerson: raw.contactPerson || "",
    phone: raw.phone || "",
    email: raw.email || "",
    trnNo: raw.trnNo || "",
    poBox: raw.poBox || "",
    location: raw.location || "",
    courseRates: raw.courseRates ?? null,
    meta: {
      companyName: raw.companyName,
      trnNo: raw.trnNo || "",
      location: raw.location || "",
    },
  };
}
